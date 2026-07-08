import { warn } from './log'
import { recordApiUsage } from './storage'
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
  gemini: 'gemini-2.5-flash',
  anthropic: 'claude-haiku-4-5',
  openai: 'gpt-5-mini',
}

/** Per-provider transcript chunk budget (chars). Long videos are chunked. */
const MAX_INPUT_CHARS: Record<LlmProvider, number> = {
  // Smaller chunks for Nano = faster per-call = far less timeout risk, at the
  // cost of more chunks. Constrained decoding over a big input is what stalls.
  builtin: 7_000,
  // Gemini's 1M-token context fits even a 3-hour transcript in one call —
  // no chunking, no per-chunk timeout risk.
  gemini: 400_000,
  anthropic: 60_000,
  openai: 60_000,
}

const CHUNK_OVERLAP_LINES = 5

/**
 * Hard cap per LLM call. The built-in model in particular can grind for
 * minutes (or hang) on constrained decoding over a chunk; a stuck call must
 * resolve to an error, never leave the UI at "Analyzing…" forever. Cloud
 * providers are fast, so a shorter cap catches genuine hangs sooner.
 */
const CHUNK_TIMEOUT_MS: Record<LlmProvider, number> = {
  builtin: 120_000,
  gemini: 90_000, // large single-call inputs take a bit longer
  anthropic: 60_000,
  openai: 60_000,
}

const SYSTEM_PROMPT = `You analyze YouTube video transcripts to find paid promotional segments that viewers may want to skip.

Mark a segment ONLY when the creator is clearly delivering promotion:
- "sponsor": a paid sponsor read for a third-party brand (e.g. "this video is sponsored by...", discount codes, sponsor URLs).
- "self-promo": promotion of the creator's own merch, courses, Patreon, channel memberships, or other videos, delivered as an interruption.
- "ad-read": other embedded advertising read by the creator.

Do NOT mark:
- Ordinary product or brand mentions that are part of the video's actual topic (a review of a product is content, not a sponsor read, even if positive).
- Discussion, news, analysis, or opinions ABOUT companies or products (e.g. hosts debating Meta's AI spending is content, not advertising).
- Thanks to viewers or generic "like and subscribe" moments under 5 seconds.

Most videos contain 0-3 promotional segments; many contain none. Precision matters more than recall: when unsure, either omit the segment or give it low confidence. Never guess timestamps — use the transcript's [time] markers, and extend end to where normal content resumes.

Respond with ONLY this JSON, no prose, no markdown fences:
{"segments": [{"start": <seconds>, "end": <seconds>, "type": "sponsor"|"self-promo"|"ad-read", "confidence": <0..1>}]}
If there are no promotional segments: {"segments": []}`

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
  let failures = 0
  let lastError: unknown
  for (const [index, chunk] of chunks.entries()) {
    onProgress?.(index, chunks.length)
    if (signal.aborted) throw new LlmError('Aborted')
    const prompt = buildPrompt(chunk, durationSeconds)
    try {
      segments.push(
        ...(await completeWithRetry(
          provider,
          prompt,
          durationSeconds,
          settings,
          signal,
        )),
      )
    } catch (error) {
      if (signal.aborted) throw error
      // Rate limit: stop immediately so the caller re-runs the whole analysis
      // on the built-in model (chunked correctly for it).
      if (error instanceof RateLimitError) throw error
      // One slow/failed chunk shouldn't discard the whole video's analysis —
      // that section just loses its segments (a possible late/missed skip).
      failures++
      lastError = error
      warn(
        `chunk ${index + 1}/${chunks.length} failed:`,
        error instanceof Error ? error.message : error,
      )
    }
  }
  // Only a total wipeout is a real failure. Surface the ACTUAL provider error
  // (e.g. "Gemini API 400: invalid key") rather than a generic message.
  if (chunks.length > 0 && failures === chunks.length) {
    throw lastError instanceof Error
      ? lastError
      : new LlmError(`All ${chunks.length} analysis chunk(s) failed`)
  }
  onProgress?.(chunks.length, chunks.length)
  return verifySegments(mergeSegments(segments), lines)
}

// ---------------------------------------------------------------------------
// Verification layer — never trust the model blindly
// ---------------------------------------------------------------------------

/**
 * Real ad reads virtually always contain explicit promotional language. Any
 * single strong marker in the covered text passes the segment. Includes
 * legal-disclaimer and app/betting-ad phrasing (e.g. "gambling problem",
 * "21 and over") — these almost never appear in normal content, so they're a
 * near-zero-false-positive tell for the ad reads that lack classic
 * "sponsored by" vocabulary.
 */
const STRONG_MARKERS = [
  // Classic sponsor reads
  'sponsor',
  'sponsored',
  'brought to you by',
  'support for the show',
  'support for this show',
  'support for today',
  'supporting the show',
  'this episode is supported',
  'promo code',
  'use code',
  'discount code',
  'with code',
  'coupon',
  'free trial',
  'free shipping',
  'patreon',
  'merch',
  'channel member',
  'my course',
  'thanks to today',
  // App / retail / betting reads
  'new customers',
  'new user',
  'sign up with',
  'available in all 50',
  'download the app',
  'in the app store',
  'on the app store',
  'google play',
  // Legal disclaimers — essentially ad-exclusive
  'terms and conditions',
  'terms apply',
  'gambling problem',
  'gambler',
  '21 and over',
  '21+',
  'void where prohibited',
  'void in',
  'message and data rates',
  'msg and data rates',
  'restrictions apply',
  'see terms',
  'terms at',
]

const WEAK_MARKERS = [
  'go to',
  'head to',
  'check out',
  'sign up',
  'link in the description',
  'link below',
  '.com/',
  '.ai/',
  '.co/',
  '% off',
  'percent off',
  'get started',
  'download',
  'subscribe to',
]

/** Longer than this is almost certainly not a single ad read. */
const MAX_SEGMENT_SECONDS = 210
/** More flagged segments than this means the model is hallucinating; keep the most confident. */
const MAX_SEGMENTS = 8

/**
 * Cross-check every model-claimed segment against the transcript text it
 * covers: keep it only if the words actually sound like promotion (≥1 strong
 * marker, or ≥2 distinct weak ones). Protects against small-model precision
 * collapse — a false skip that cuts real content is the worst failure mode.
 */
export function verifySegments(
  segments: SponsorSegment[],
  lines: TranscriptLine[],
): SponsorSegment[] {
  const verified = segments.filter((segment) => {
    if (segment.end - segment.start > MAX_SEGMENT_SECONDS) return false
    const text = lines
      .filter((l) => l.end > segment.start - 2 && l.start < segment.end + 2)
      .map((l) => l.text)
      .join(' ')
      .toLowerCase()
    if (!text) return false
    if (STRONG_MARKERS.some((m) => text.includes(m))) return true
    const weakHits = WEAK_MARKERS.filter((m) => text.includes(m)).length
    return weakHits >= 2
  })
  return verified
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, MAX_SEGMENTS)
    .sort((a, b) => a.start - b.start)
}

// ---------------------------------------------------------------------------
// Self-healing selectors (Phase 8)
// ---------------------------------------------------------------------------

const SELECTOR_SYSTEM_PROMPT = `You locate a UI element inside an HTML fragment. Given a description and the fragment, return ONLY JSON: {"selector":"<css selector>"} matching that element, or {"selector":null} if it isn't present. The selector must be valid for document.querySelector and should prefer stable attributes (class names, aria-label, role, data-*) over randomly generated ids. No prose, no markdown, no explanation.`

/**
 * Ask the configured LLM to find a CSS selector for an element described in
 * `description` within `html`. Used to auto-repair YouTube selectors when a
 * DOM change breaks the hardcoded ones. Returns null if nothing usable.
 */
export async function findElementSelector(
  html: string,
  description: string,
  settings: Settings,
  signal: AbortSignal,
): Promise<string | null> {
  const prompt = `Find this element: ${description}\n\nHTML fragment:\n${html.slice(0, 8000)}`
  const raw = await completeSmart(SELECTOR_SYSTEM_PROMPT, prompt, settings, signal)
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
  const first = cleaned.indexOf('{')
  const last = cleaned.lastIndexOf('}')
  if (first === -1 || last <= first) return null
  try {
    const parsed = JSON.parse(cleaned.slice(first, last + 1))
    const selector = parsed?.selector
    return typeof selector === 'string' && selector.trim() ? selector.trim() : null
  } catch {
    return null
  }
}

const GAPFILL_SYSTEM_PROMPT = `You find advertisement elements in an HTML fragment from a web page. Ads include banner/display ads, sponsored promo blocks, ad iframes, and native "advertisement"/"sponsored" units — NOT the page's real content, navigation, or its own product listings on a shopping site. Return ONLY JSON: {"selectors":["<css>", ...]} — CSS selectors (valid for querySelectorAll) that match ONLY ad containers, preferring stable attributes (class, id, aria-label, data-*). Be conservative: if unsure whether something is an ad, leave it out. If there are no ads, return {"selectors":[]}. No prose, no markdown.`

/**
 * AI gap-filler: ask the LLM which elements in `html` are ads the filter lists
 * missed. Returns CSS selectors to hide. Conservative by construction.
 */
export async function findAdSelectors(
  html: string,
  settings: Settings,
  signal: AbortSignal,
): Promise<string[]> {
  const prompt = `Page ad-like fragment:\n${html.slice(0, 9000)}`
  const raw = await completeSmart(GAPFILL_SYSTEM_PROMPT, prompt, settings, signal)
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
  const first = cleaned.indexOf('{')
  const last = cleaned.lastIndexOf('}')
  if (first === -1 || last <= first) return []
  try {
    const parsed = JSON.parse(cleaned.slice(first, last + 1))
    if (!Array.isArray(parsed.selectors)) return []
    return parsed.selectors
      .filter((s: unknown): s is string => typeof s === 'string' && !!s.trim())
      .map((s: string) => s.trim())
      .slice(0, 12)
  } catch {
    return []
  }
}

const POPUP_SYSTEM_PROMPT = `You decide whether an on-page overlay/popup should be hidden. HIDE only intrusive annoyances: newsletter/email-signup walls, promotional/discount popups, "subscribe" interstitials, app-install nags, survey/feedback popups, and popup/overlay ADS. KEEP (do not hide) anything functional or that the user may need: login/sign-in dialogs, authentication (OAuth), cookie/consent choices, age verification, payment/checkout, error or confirmation dialogs, and the site's actual content. When unsure, KEEP. Respond with ONLY JSON: {"hide": true|false}. No prose.`

/** Decide whether an overlay is an intrusive annoyance (hide) or functional (keep). */
export async function reviewPopup(
  html: string,
  settings: Settings,
  signal: AbortSignal,
): Promise<boolean> {
  const raw = await completeSmart(
    POPUP_SYSTEM_PROMPT,
    `Overlay HTML:\n${html.slice(0, 4000)}`,
    settings,
    signal,
  )
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  const first = cleaned.indexOf('{')
  const last = cleaned.lastIndexOf('}')
  if (first === -1 || last <= first) return false
  try {
    return JSON.parse(cleaned.slice(first, last + 1)).hide === true
  } catch {
    return false
  }
}

const CONSENT_SYSTEM_PROMPT = `You are given the HTML of a cookie-consent / privacy banner. Find the button that REJECTS non-essential cookies — the most privacy-protective choice (labels like "Reject all", "Decline", "Necessary only", "Only essential", "Refuse", "Deny"). Return ONLY JSON: {"selector":"<css>"} for a clickable element (button/a) that performs that rejection, or {"selector":null} if there is no clear reject option (do NOT return an "Accept" button — never). Prefer stable attributes. No prose.`

/** Find the "reject all / necessary only" button in a cookie banner. Never returns Accept. */
export async function findConsentReject(
  html: string,
  settings: Settings,
  signal: AbortSignal,
): Promise<string | null> {
  const raw = await completeSmart(
    CONSENT_SYSTEM_PROMPT,
    `Banner HTML:\n${html.slice(0, 5000)}`,
    settings,
    signal,
  )
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  const first = cleaned.indexOf('{')
  const last = cleaned.lastIndexOf('}')
  if (first === -1 || last <= first) return null
  try {
    const sel = JSON.parse(cleaned.slice(first, last + 1)).selector
    return typeof sel === 'string' && sel.trim() ? sel.trim() : null
  } catch {
    return null
  }
}

/** Thrown when a provider returns a rate-limit / quota-exhausted status. */
export class RateLimitError extends LlmError {}

// ---------------------------------------------------------------------------
// Client-side request pacing — Gemini's free tier allows only ~5 requests per
// minute, and AI-enhancement helper calls (popup review, gap-fill, consent)
// can easily burst past that. Space our own calls so we rarely see a 429 at
// all, instead of hitting one and losing the provider to cooldown.
// ---------------------------------------------------------------------------

/** Self-imposed requests-per-minute cap (rolling 60s window), per provider. */
const RPM_SELF_CAP: Partial<Record<LlmProvider, number>> = {
  gemini: 4, // free tier is 5 RPM; stay one under for other tabs/devices
}

const recentCallTimes = new Map<LlmProvider, number[]>()

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new LlmError('Aborted'))
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new LlmError('Aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Wait (abortably) until the provider has a free slot in its RPM window. */
async function paceRequests(
  provider: LlmProvider,
  signal: AbortSignal,
): Promise<void> {
  const cap = RPM_SELF_CAP[provider]
  if (!cap) return
  for (;;) {
    const now = Date.now()
    const times = (recentCallTimes.get(provider) ?? []).filter(
      (t) => now - t < 60_000,
    )
    if (times.length < cap) {
      times.push(now)
      recentCallTimes.set(provider, times)
      return
    }
    const waitMs = 60_000 - (now - times[0]) + 500
    warn(`${provider} pacing: waiting ${Math.round(waitMs / 1000)}s to stay under ${cap}/min`)
    await abortableSleep(waitMs, signal)
  }
}

/** Providers in cooldown after hitting a limit → epoch ms until we try them again. */
const cooldownUntil = new Map<LlmProvider, number>()

function inCooldown(provider: LlmProvider): boolean {
  const until = cooldownUntil.get(provider)
  return until !== undefined && Date.now() < until
}

/** Mark a provider rate-limited. Longer for daily-quota errors than per-minute ones. */
function setCooldown(provider: LlmProvider, dailyQuota: boolean, retryAfterSec?: number) {
  const ms = retryAfterSec
    ? retryAfterSec * 1000
    : dailyQuota
      ? 60 * 60 * 1000 // ~1h for daily quota exhaustion
      : 90 * 1000 // short, for per-minute rate limits
  cooldownUntil.set(provider, Date.now() + ms)
  warn(`${provider} rate-limited — falling back to built-in AI for ~${Math.round(ms / 1000)}s`)
}

export function resolveProvider(settings: Settings): LlmProvider {
  const provider = settings.llmProvider
  if (
    provider !== 'builtin' &&
    settings.apiKeys[provider]?.trim() &&
    !inCooldown(provider) // fall back to built-in while rate-limited
  ) {
    return provider
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
      // Pace BEFORE starting the timeout clock — a rate-limit wait isn't a hang.
      await paceRequests(provider, signal)
      const raw = await withTimeout(
        complete(provider, SYSTEM_PROMPT, prompt, settings, signal),
        CHUNK_TIMEOUT_MS[provider],
      )
      return parseSegments(raw, durationSeconds)
    } catch (error) {
      if (signal.aborted) throw error
      // A timed-out model won't get faster on an immediate retry.
      if (error instanceof TimeoutError) throw error
      // Rate limit → bail out so the whole analysis re-runs on the built-in model.
      if (error instanceof RateLimitError) throw error
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new LlmError(String(lastError))
}

export class TimeoutError extends LlmError {}

/**
 * Resolve the provider, run one completion, and — if a cloud provider is
 * rate-limited — transparently retry on the built-in model. Used by the small
 * single-shot AI helpers (selector heal, gap-fill, popup review, consent).
 */
async function completeSmart(
  system: string,
  prompt: string,
  settings: Settings,
  signal: AbortSignal,
): Promise<string> {
  const provider = resolveProvider(settings)
  try {
    await paceRequests(provider, signal)
    return await withTimeout(
      complete(provider, system, prompt, settings, signal),
      CHUNK_TIMEOUT_MS[provider],
    )
  } catch (error) {
    if (error instanceof RateLimitError && provider !== 'builtin') {
      // Cooldown is set; fall back to on-device AI for this call.
      return await withTimeout(
        complete('builtin', system, prompt, settings, signal),
        CHUNK_TIMEOUT_MS.builtin,
      )
    }
    throw error
  }
}

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
  system: string,
  prompt: string,
  settings: Settings,
  signal: AbortSignal,
): Promise<string> {
  switch (provider) {
    case 'anthropic':
      return completeAnthropic(system, prompt, settings, signal)
    case 'openai':
      return completeOpenAiCompatible(
        'https://api.openai.com/v1/chat/completions',
        'openai',
        system,
        prompt,
        settings,
        signal,
      )
    case 'gemini':
      return completeOpenAiCompatible(
        'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
        'gemini',
        system,
        prompt,
        settings,
        signal,
      )
    case 'builtin':
      return completeBuiltin(system, prompt, signal)
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
  system: string,
  prompt: string,
  settings: Settings,
  signal: AbortSignal,
): Promise<string> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      'x-api-key': (settings.apiKeys.anthropic ?? '').trim(),
      'anthropic-version': '2023-06-01',
      // Extension service-worker fetch is browser-originated.
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: settings.model.trim() || DEFAULT_MODELS.anthropic,
      max_tokens: 1500,
      temperature: 0,
      system,
      messages: [{ role: 'user', content: prompt }],
    }),
  })
  if (!response.ok) {
    const body = await safeText(response)
    throwForStatus('anthropic', response, body)
    throw new LlmError(`Anthropic API ${response.status}: ${body}`)
  }
  const data = await response.json()
  const text = data?.content?.[0]?.text
  if (typeof text !== 'string') throw new LlmError('Empty Anthropic response')
  void recordApiUsage(
    'anthropic',
    Number(data?.usage?.input_tokens) || 0,
    Number(data?.usage?.output_tokens) || 0,
  )
  return text
}

/** OpenAI-compatible chat-completions call. Used by OpenAI and Gemini (whose
 * `/v1beta/openai/` endpoint speaks the same protocol). */
async function completeOpenAiCompatible(
  url: string,
  provider: 'openai' | 'gemini',
  system: string,
  prompt: string,
  settings: Settings,
  signal: AbortSignal,
): Promise<string> {
  const response = await fetch(url, {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${(settings.apiKeys[provider] ?? '').trim()}`,
    },
    body: JSON.stringify({
      model: settings.model.trim() || DEFAULT_MODELS[provider],
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
    }),
  })
  if (!response.ok) {
    const body = await safeText(response)
    throwForStatus(provider, response, body)
    const label = provider === 'gemini' ? 'Gemini' : 'OpenAI'
    throw new LlmError(`${label} API ${response.status}: ${body}`)
  }
  const data = await response.json()
  const text = data?.choices?.[0]?.message?.content
  if (typeof text !== 'string') throw new LlmError('Empty API response')
  void recordApiUsage(
    provider,
    Number(data?.usage?.prompt_tokens) || 0,
    Number(data?.usage?.completion_tokens) || 0,
  )
  return text
}

async function completeBuiltin(
  system: string,
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
    return await session.prompt(`${system}\n\n${prompt}`)
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

/**
 * If the response is a rate-limit / quota error, mark the provider for cooldown
 * and throw RateLimitError so callers fall back to the built-in model.
 */
function throwForStatus(
  provider: LlmProvider,
  response: Response,
  body: string,
) {
  const quotaHint = /quota|exhausted|per day|daily limit|insufficient_quota/i.test(
    body,
  )
  if (response.status === 429 || (response.status === 403 && quotaHint)) {
    const retryAfter = Number(response.headers.get('retry-after')) || undefined
    setCooldown(provider, quotaHint, retryAfter)
    throw new RateLimitError(`${provider} rate limit / quota reached`)
  }
}
