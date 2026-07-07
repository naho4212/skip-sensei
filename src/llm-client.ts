import type {
  LlmProvider,
  Settings,
  SponsorSegment,
  TranscriptLine,
} from './types'

/**
 * Model-agnostic LLM client (runs in the service worker).
 *
 * Providers:
 *  - 'builtin'   Chrome's on-device Gemini Nano via the Prompt API — free,
 *                zero setup, the default.
 *  - 'anthropic' Claude via user-supplied API key.
 *  - 'openai'    OpenAI via user-supplied API key.
 *
 * Output contract: strict JSON `{"segments": [{start, end, type, confidence}]}`.
 * Validation happens here; a response that doesn't parse is retried once and
 * then surfaces as an error — callers degrade to ad-skipping only.
 */

const DEFAULT_MODELS: Record<Exclude<LlmProvider, 'builtin'>, string> = {
  anthropic: 'claude-haiku-4-5',
  openai: 'gpt-5-mini',
}

/** Per-provider transcript chunk budget (chars). Long videos are chunked. */
const MAX_INPUT_CHARS: Record<LlmProvider, number> = {
  builtin: 12_000, // Nano's context window is small
  anthropic: 60_000,
  openai: 60_000,
}

const CHUNK_OVERLAP_LINES = 5

/**
 * Hard cap per LLM call. The built-in model in particular can grind for
 * minutes (or hang) on constrained decoding over a large chunk; a stuck call
 * must resolve to an error, never leave the UI at "Analyzing…" forever.
 */
const CHUNK_TIMEOUT_MS = 90_000

const SYSTEM_PROMPT = `You analyze YouTube video transcripts to find paid promotional segments that viewers may want to skip.

Mark a segment ONLY when the creator is clearly delivering promotion:
- "sponsor": a paid sponsor read for a third-party brand (e.g. "this video is sponsored by...", discount codes, sponsor URLs).
- "self-promo": promotion of the creator's own merch, courses, Patreon, channel memberships, or other videos, delivered as an interruption.
- "ad-read": other embedded advertising read by the creator.

Do NOT mark:
- Ordinary product or brand mentions that are part of the video's actual topic (a review of a product is content, not a sponsor read, even if positive).
- Thanks to viewers or generic "like and subscribe" moments under 5 seconds.

Precision matters more than recall: when unsure, either omit the segment or give it low confidence. Never guess timestamps — use the transcript's [time] markers, and extend end to where normal content resumes.

Respond with ONLY this JSON, no prose, no markdown fences:
{"segments": [{"start": <seconds>, "end": <seconds>, "type": "sponsor"|"self-promo"|"ad-read", "confidence": <0..1>}]}
If there are no promotional segments: {"segments": []}`

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    segments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          start: { type: 'number' },
          end: { type: 'number' },
          type: { type: 'string', enum: ['sponsor', 'self-promo', 'ad-read'] },
          confidence: { type: 'number' },
        },
        required: ['start', 'end', 'type', 'confidence'],
      },
    },
  },
  required: ['segments'],
} as const

export class LlmError extends Error {}

export async function analyzeTranscript(
  lines: TranscriptLine[],
  durationSeconds: number,
  settings: Settings,
  signal: AbortSignal,
  onProgress?: (done: number, total: number) => void,
): Promise<SponsorSegment[]> {
  const provider = resolveProvider(settings)
  const chunks = chunkLines(lines, MAX_INPUT_CHARS[provider])
  const segments: SponsorSegment[] = []
  for (const [index, chunk] of chunks.entries()) {
    onProgress?.(index, chunks.length)
    const prompt = buildPrompt(chunk, durationSeconds)
    segments.push(
      ...(await completeWithRetry(provider, prompt, durationSeconds, settings, signal)),
    )
  }
  onProgress?.(chunks.length, chunks.length)
  return mergeSegments(segments)
}

export function resolveProvider(settings: Settings): LlmProvider {
  if (settings.llmProvider !== 'builtin' && settings.apiKey.trim()) {
    return settings.llmProvider
  }
  return 'builtin'
}

export async function builtinAvailability(): Promise<string> {
  if (typeof LanguageModel === 'undefined' || !LanguageModel) {
    return 'unavailable'
  }
  try {
    return await LanguageModel.availability()
  } catch {
    return 'unavailable'
  }
}

// ---------------------------------------------------------------------------
// Prompt + chunking
// ---------------------------------------------------------------------------

function buildPrompt(lines: TranscriptLine[], durationSeconds: number): string {
  const body = lines
    .map((line) => `[${line.start.toFixed(1)}] ${line.text}`)
    .join('\n')
  return `Video duration: ${Math.round(durationSeconds)} seconds. Transcript (each line prefixed with its start time in seconds):\n\n${body}`
}

function chunkLines(
  lines: TranscriptLine[],
  maxChars: number,
): TranscriptLine[][] {
  const chunks: TranscriptLine[][] = []
  let current: TranscriptLine[] = []
  let chars = 0
  for (const line of lines) {
    const lineChars = line.text.length + 12 // + timestamp prefix
    if (chars + lineChars > maxChars && current.length > 0) {
      chunks.push(current)
      current = current.slice(-CHUNK_OVERLAP_LINES)
      chars = current.reduce((sum, l) => sum + l.text.length + 12, 0)
    }
    current.push(line)
    chars += lineChars
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

/** Merge overlapping/adjacent same-type segments from chunked analysis. */
function mergeSegments(segments: SponsorSegment[]): SponsorSegment[] {
  const sorted = [...segments].sort((a, b) => a.start - b.start)
  const merged: SponsorSegment[] = []
  for (const segment of sorted) {
    const last = merged[merged.length - 1]
    if (last && segment.start <= last.end + 2 && segment.type === last.type) {
      last.end = Math.max(last.end, segment.end)
      last.confidence = Math.max(last.confidence, segment.confidence)
    } else {
      merged.push({ ...segment })
    }
  }
  return merged
}

// ---------------------------------------------------------------------------
// Completion + validation
// ---------------------------------------------------------------------------

async function completeWithRetry(
  provider: LlmProvider,
  prompt: string,
  durationSeconds: number,
  settings: Settings,
  signal: AbortSignal,
): Promise<SponsorSegment[]> {
  let lastError: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await withTimeout(
        complete(provider, prompt, settings, signal),
        CHUNK_TIMEOUT_MS,
      )
      return parseSegments(raw, durationSeconds)
    } catch (error) {
      if (signal.aborted) throw error
      // A timed-out model won't get faster on an immediate retry.
      if (error instanceof TimeoutError) throw error
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new LlmError(String(lastError))
}

export class TimeoutError extends LlmError {}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new TimeoutError(`LLM call timed out after ${ms / 1000}s`)),
      ms,
    )
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function complete(
  provider: LlmProvider,
  prompt: string,
  settings: Settings,
  signal: AbortSignal,
): Promise<string> {
  switch (provider) {
    case 'anthropic':
      return completeAnthropic(prompt, settings, signal)
    case 'openai':
      return completeOpenAi(prompt, settings, signal)
    case 'builtin':
      return completeBuiltin(prompt, signal)
  }
}

export function parseSegments(
  raw: string,
  durationSeconds: number,
): SponsorSegment[] {
  // Models occasionally fence output despite instructions; strip defensively.
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
  const firstBrace = cleaned.indexOf('{')
  const lastBrace = cleaned.lastIndexOf('}')
  if (firstBrace === -1 || lastBrace <= firstBrace) {
    throw new LlmError('No JSON object in response')
  }
  const parsed = JSON.parse(cleaned.slice(firstBrace, lastBrace + 1))
  if (!Array.isArray(parsed.segments)) {
    throw new LlmError('Missing "segments" array')
  }

  const maxEnd = durationSeconds > 0 ? durationSeconds + 5 : Infinity
  const segments: SponsorSegment[] = []
  for (const item of parsed.segments) {
    const start = Number(item?.start)
    const end = Number(item?.end)
    const confidence = Number(item?.confidence)
    const type = item?.type
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      !Number.isFinite(confidence) ||
      !['sponsor', 'self-promo', 'ad-read'].includes(type)
    ) {
      throw new LlmError('Malformed segment object')
    }
    if (start < 0 || end <= start || start > maxEnd) continue // drop nonsense quietly
    segments.push({
      start,
      end: Math.min(end, maxEnd),
      type,
      confidence: Math.min(1, Math.max(0, confidence)),
    })
  }
  return segments
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

async function completeAnthropic(
  prompt: string,
  settings: Settings,
  signal: AbortSignal,
): Promise<string> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      'x-api-key': settings.apiKey.trim(),
      'anthropic-version': '2023-06-01',
      // Extension service-worker fetch is browser-originated.
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: settings.model.trim() || DEFAULT_MODELS.anthropic,
      max_tokens: 1500,
      temperature: 0,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
    }),
  })
  if (!response.ok) {
    throw new LlmError(`Anthropic API ${response.status}: ${await safeText(response)}`)
  }
  const data = await response.json()
  const text = data?.content?.[0]?.text
  if (typeof text !== 'string') throw new LlmError('Empty Anthropic response')
  return text
}

async function completeOpenAi(
  prompt: string,
  settings: Settings,
  signal: AbortSignal,
): Promise<string> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${settings.apiKey.trim()}`,
    },
    body: JSON.stringify({
      model: settings.model.trim() || DEFAULT_MODELS.openai,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
    }),
  })
  if (!response.ok) {
    throw new LlmError(`OpenAI API ${response.status}: ${await safeText(response)}`)
  }
  const data = await response.json()
  const text = data?.choices?.[0]?.message?.content
  if (typeof text !== 'string') throw new LlmError('Empty OpenAI response')
  return text
}

async function completeBuiltin(
  prompt: string,
  signal: AbortSignal,
): Promise<string> {
  if (typeof LanguageModel === 'undefined' || !LanguageModel) {
    throw new LlmError(
      'Built-in Chrome AI is not available in this browser. Add an API key in Ad Sensei options, or use Chrome 138+ with on-device AI enabled.',
    )
  }
  const availability = await LanguageModel.availability()
  if (availability === 'unavailable') {
    throw new LlmError(
      'Built-in Chrome AI is unavailable on this device. Add an API key in Ad Sensei options.',
    )
  }
  // 'downloadable'/'downloading': create() kicks off / waits for the model download.
  const session = await LanguageModel.create({ temperature: 0.1, topK: 3 })
  try {
    if (signal.aborted) throw new LlmError('Aborted')
    const fullPrompt = `${SYSTEM_PROMPT}\n\n${prompt}`
    try {
      return await session.prompt(fullPrompt, {
        responseConstraint: RESPONSE_SCHEMA,
      })
    } catch {
      // Older Chrome without structured-output support.
      return await session.prompt(fullPrompt)
    }
  } finally {
    session.destroy()
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 300)
  } catch {
    return ''
  }
}
