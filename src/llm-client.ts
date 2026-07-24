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

// Provider defaults. Prefer a floating "latest" alias wherever the provider
// maintains one — Google rotates the model behind `gemini-flash-latest`, so the
// default tracks the current model with no extension release, and a retired
// snapshot id can't 404 the default. OpenAI's bare names already float to the
// current snapshot. Providers without a real alias (Groq, OpenRouter) pin a
// current model and rely on the ModelUnavailableError self-heal below when one
// is retired. Keep these current as a floor, not a ceiling.
const DEFAULT_MODELS: Record<Exclude<LlmProvider, 'builtin'>, string> = {
  gemini: 'gemini-flash-latest',
  anthropic: 'claude-haiku-4-5',
  openai: 'gpt-5-mini',
  groq: 'llama-3.3-70b-versatile',
  openrouter: 'meta-llama/llama-3.3-70b-instruct:free',
  ollama: 'llama3.1:8b',
  // For OpenClaw the "model" is an agent target, not a model id.
  openclaw: 'openclaw',
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
  // Groq's free tier is ~6-12K tokens/MINUTE — small chunks + pacing or every
  // long transcript 429s immediately.
  groq: 18_000,
  openrouter: 60_000,
  // Local models are slow; keep chunks modest so one call stays in the timeout.
  ollama: 24_000,
  openclaw: 60_000,
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
  groq: 60_000,
  openrouter: 90_000, // free pools can queue under load
  ollama: 180_000, // local inference is RAM/CPU-bound
  openclaw: 180_000, // full agent runs, plus possibly a local model behind it
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
      // A gone model 404s every chunk identically — bail on the first so the
      // caller's fallback chain moves on instead of retrying it N more times.
      if (error instanceof ModelUnavailableError) throw error
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

const AD_VERIFY_SYSTEM_PROMPT = `You review suspected advertisement elements found on a web page. Each numbered candidate carried a WEAK ad signal (ad-network iframe, ad-like class name, or a "Sponsored" label) and comes with its visible text and an HTML snippet. Confirm ONLY candidates that are beyond doubt advertisements: banner/display ad units, ad iframes, sponsored/promoted third-party content. Everything else is NOT an ad — the site's own UI (navigation, headers, buttons, forms, feature promos), real content (articles, product cards, search results), and especially USER CONTENT: emails, chat messages, comments, posts, documents, calendar events. Beware: many apps ship minified class names, so tokens like "ad"/"ads" land on non-ads by pure coincidence (Gmail puts class="adn ads" on every email) — a class name is NEVER sufficient evidence on its own; require the content itself to be promotional. Visible text with personal names, dates, or conversational replies means user content, never an ad. Return ONLY JSON: {"ads":[<candidate numbers>]}. When in any doubt, leave the candidate out. If none qualify, return {"ads":[]}. No prose, no markdown.`

/**
 * AI gap-filler verifier (v2): the content script finds candidates
 * deterministically and generates the selectors itself — the AI only gets a
 * veto per candidate and can never introduce an element or a selector of its
 * own. Returns the candidate indexes confirmed as ads; on any failure or
 * doubt the answer is "not an ad", so failure always means an ad might show,
 * never that real UI gets hidden.
 */
export async function verifyAdCandidates(
  candidates: Array<{ index: number; html: string; text?: string }>,
  page: { host: string; title: string } | undefined,
  settings: Settings,
  signal: AbortSignal,
): Promise<number[]> {
  const body = candidates
    .map((c) => {
      const text = (c.text ?? '').slice(0, 160)
      return `#${c.index}:\ntext: ${text || '(no visible text)'}\nhtml: ${c.html.slice(0, 700)}`
    })
    .join('\n\n')
  const header = page
    ? `Page: ${page.host} — ${page.title.slice(0, 80)}\n`
    : ''
  const raw = await completeSmart(
    AD_VERIFY_SYSTEM_PROMPT,
    `${header}Candidates:\n${body}`.slice(0, 9000),
    settings,
    signal,
  )
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
  const first = cleaned.indexOf('{')
  const last = cleaned.lastIndexOf('}')
  if (first === -1 || last <= first) return []
  try {
    const parsed = JSON.parse(cleaned.slice(first, last + 1))
    if (!Array.isArray(parsed.ads)) return []
    const known = new Set(candidates.map((c) => c.index))
    return parsed.ads
      .map((n: unknown) => Number(n))
      .filter((n: number) => Number.isInteger(n) && known.has(n))
  } catch {
    return []
  }
}

const LIST_AUDIT_SYSTEM_PROMPT = `You audit elements an ad blocker's filter lists are currently HIDING on a page. Most are genuine ads — your job is to catch the rare false positive: an element that is clearly NOT an advertisement, such as the site's own UI (search boxes, navigation, message threads, media players, forms) or user content (emails, chat messages, comments, articles, documents). Each numbered element comes with its readable text (visible text, or its labels/placeholders when it shows no text) and an HTML snippet; the page host and title are given. Note that class names can be misleading — words like "thread" or "typeahead" contain "ad" by coincidence — so judge by what the element's content actually IS. An element with no text and no controls is usually an ad slot whose ad was already blocked upstream — leave it hidden. But an element containing search inputs, compose fields, or several navigation links is site UI even when it shows no text (its ad may simply never have existed). Sponsored/promoted content, banners, ad iframes, and anything promotional must STAY hidden — never list those. Return ONLY JSON: {"notAds":[<element numbers you are CERTAIN are not ads>]}. When unsure about an element, do NOT include it. If everything looks like an ad, return {"notAds":[]}. No prose, no markdown.`

/**
 * AI audit of list-driven hides (the inverse of verifyAdCandidates): the
 * content script sends elements the filter lists are hiding that carry real
 * text, and the AI rescues clear false positives. Fail direction is "stays
 * hidden" — the lists are usually right, so on any failure or doubt nothing
 * gets un-hidden.
 */
export async function auditHiddenElements(
  candidates: Array<{ index: number; html: string; text?: string }>,
  page: { host: string; title: string } | undefined,
  settings: Settings,
  signal: AbortSignal,
): Promise<number[]> {
  const body = candidates
    .map((c) => {
      const text = (c.text ?? '').slice(0, 200)
      return `#${c.index}:\ntext: ${text || '(no visible text)'}\nhtml: ${c.html.slice(0, 600)}`
    })
    .join('\n\n')
  const header = page
    ? `Page: ${page.host} — ${page.title.slice(0, 80)}\n`
    : ''
  const raw = await completeSmart(
    LIST_AUDIT_SYSTEM_PROMPT,
    `${header}Hidden elements:\n${body}`.slice(0, 9000),
    settings,
    signal,
  )
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
  const first = cleaned.indexOf('{')
  const last = cleaned.lastIndexOf('}')
  if (first === -1 || last <= first) return []
  try {
    const parsed = JSON.parse(cleaned.slice(first, last + 1))
    if (!Array.isArray(parsed.notAds)) return []
    const known = new Set(candidates.map((c) => c.index))
    return parsed.notAds
      .map((n: unknown) => Number(n))
      .filter((n: number) => Number.isInteger(n) && known.has(n))
  } catch {
    return []
  }
}

const POPUP_SYSTEM_PROMPT = `You decide whether an on-page overlay/popup should be hidden. HIDE only intrusive annoyances: newsletter/email-signup walls, promotional/discount popups, "subscribe" interstitials, app-install nags, survey/feedback popups, and popup/overlay ADS. KEEP (do not hide) anything functional or that the user may need: login/sign-in dialogs, authentication (OAuth), cookie/consent choices, age verification, payment/checkout, error or confirmation dialogs, and the site's actual content. When unsure, KEEP. Respond with ONLY JSON: {"hide": true|false, "summary": "<neutral 3-8 word description of what the popup is, e.g. 'Newsletter signup asking for email', 'Cookie consent banner', 'Login dialog', '20% discount promo'>"}. No prose.`

/** Decide whether an overlay is an intrusive annoyance (hide) or functional (keep). */
export async function reviewPopup(
  html: string,
  settings: Settings,
  signal: AbortSignal,
): Promise<{ hide: boolean; summary: string }> {
  const raw = await completeSmart(
    POPUP_SYSTEM_PROMPT,
    `Overlay HTML:\n${html.slice(0, 4000)}`,
    settings,
    signal,
  )
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  const first = cleaned.indexOf('{')
  const last = cleaned.lastIndexOf('}')
  if (first === -1 || last <= first) return { hide: false, summary: '' }
  try {
    const obj = JSON.parse(cleaned.slice(first, last + 1))
    return {
      hide: obj.hide === true,
      summary: typeof obj.summary === 'string' ? obj.summary.trim().slice(0, 80) : '',
    }
  } catch {
    return { hide: false, summary: '' }
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

/**
 * Thrown when a provider reports the requested model id doesn't exist / is no
 * longer available (a retired snapshot, a typo'd Custom id). Distinct from a
 * generic error so callers can self-heal to a working model instead of failing
 * the analysis — the same graceful degradation we do for a rate limit.
 */
export class ModelUnavailableError extends LlmError {}

// ---------------------------------------------------------------------------
// Client-side request pacing — Gemini's free tier allows only ~5 requests per
// minute, and AI-enhancement helper calls (popup review, gap-fill, consent)
// can easily burst past that. Space our own calls so we rarely see a 429 at
// all, instead of hitting one and losing the provider to cooldown.
// ---------------------------------------------------------------------------

/** Self-imposed requests-per-minute cap (rolling 60s window), per provider. */
const RPM_SELF_CAP: Partial<Record<LlmProvider, number>> = {
  gemini: 4, // free tier is 5 RPM; stay one under for other tabs/devices
  groq: 25, // free tier is 30 RPM
  openrouter: 15, // :free models are 20 RPM
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

/** Is this provider actually usable right now (configured + not rate-limited)? */
function usable(provider: LlmProvider, settings: Settings): boolean {
  if (provider === 'builtin') return true
  if (inCooldown(provider)) return false // fall back while rate-limited
  if (provider === 'ollama') return true // local, keyless
  if (provider === 'openclaw') return true // local gateway; token optional (auth "none" mode)
  return !!settings.apiKeys[provider]?.trim()
}

export function resolveProvider(settings: Settings): LlmProvider {
  // Local-only mode forbids any external call — on-device AI only.
  if (settings.localOnlyMode) return 'builtin'
  return usable(settings.llmProvider, settings) ? settings.llmProvider : 'builtin'
}

/**
 * Providers we auto-try as fallbacks. FREE-tier only — a saved paid key
 * (OpenAI/Anthropic) is never auto-charged; it's used only when the user
 * explicitly selects it. Local providers (ollama/openclaw) likewise run only
 * when selected. The type excludes all of them so a paid provider can't be
 * re-added here by accident.
 */
const FREE_FALLBACK_ORDER: Exclude<
  LlmProvider,
  'builtin' | 'ollama' | 'openclaw' | 'openai' | 'anthropic'
>[] = ['gemini', 'groq', 'openrouter']

/**
 * Ordered provider configs to try for one analysis — best-effort across every
 * credential the user has saved, ending at on-device AI so "all fallbacks
 * failed" still yields a result. Order:
 *   1. the selected provider with the user's exact model override,
 *   2. the same provider on its auto-updating default (only if they'd pinned a
 *      model — covers a retired snapshot / a Custom id typo'd for the wrong
 *      provider, e.g. a Gemini id while Groq is selected),
 *   3. every OTHER FREE-tier provider they have a key for and that isn't
 *      cooling down, each on ITS OWN default model (never the selected
 *      provider's override — a Gemini id sent to Groq is a guaranteed 404),
 *   4. the built-in on-device model, always last.
 *
 * Selecting built-in or Local-only mode collapses this to on-device only — an
 * explicit privacy choice we don't override by reaching for a saved key. Paid
 * keys (OpenAI/Anthropic) are never auto-tried: they run only as the user's
 * selected provider (steps 1-2), so a fallback can't silently spend money. The
 * caller logs which provider actually ran.
 */
export function providerFallbackChain(settings: Settings): Settings[] {
  const variant = (llmProvider: LlmProvider, model: string): Settings => ({
    ...settings,
    llmProvider,
    model,
  })
  const selected = settings.llmProvider
  if (settings.localOnlyMode || selected === 'builtin') {
    return [variant('builtin', '')]
  }

  const chain: Settings[] = [variant(selected, settings.model)]
  if (settings.model.trim()) chain.push(variant(selected, ''))
  for (const provider of FREE_FALLBACK_ORDER) {
    if (provider === selected) continue
    if (settings.apiKeys[provider]?.trim() && !inCooldown(provider)) {
      chain.push(variant(provider, ''))
    }
  }
  chain.push(variant('builtin', ''))
  return chain
}

/**
 * Provider for the small AI-enhancement helper calls (popup review, consent,
 * selector heal, gap-fill). These are bursty 1-2K-token calls — exactly what
 * blows Gemini's 5-requests/minute free tier. Groq's free tier is ~30 RPM /
 * 14.4K requests/day, so when a Groq key exists the helpers use it and leave
 * the main provider's quota for transcript analysis.
 */
export function resolveHelperProvider(settings: Settings): LlmProvider {
  if (settings.localOnlyMode) return 'builtin' // on-device only
  if (settings.llmProvider !== 'groq' && usable('groq', settings)) {
    return 'groq'
  }
  const provider = resolveProvider(settings)
  // NEVER send page HTML to OpenClaw: helper prompts embed content from
  // arbitrary websites, and the gateway runs full agent turns with operator
  // permissions — that would hand any malicious page a prompt-injection
  // channel into an agent that can act. OpenClaw gets transcripts only.
  return provider === 'openclaw' ? 'builtin' : provider
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
        complete(
          provider,
          resolveModel(provider, settings),
          SYSTEM_PROMPT,
          prompt,
          settings,
          signal,
        ),
        CHUNK_TIMEOUT_MS[provider],
      )
      return parseSegments(raw, durationSeconds)
    } catch (error) {
      if (signal.aborted) throw error
      // A timed-out model won't get faster on an immediate retry.
      if (error instanceof TimeoutError) throw error
      // Rate limit → bail out so the whole analysis re-runs on the built-in model.
      if (error instanceof RateLimitError) throw error
      // A missing model won't reappear on a same-model retry — bail out so the
      // caller can switch to a working model / the built-in one.
      if (error instanceof ModelUnavailableError) throw error
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new LlmError(String(lastError))
}

export class TimeoutError extends LlmError {}

/** Helpers on Groq always use the fast small model — its free tier allows
 * 14.4K requests/day (vs ~1K on the 70B), and the tasks are simple. */
const GROQ_HELPER_MODEL = 'llama-3.1-8b-instant'

/**
 * Resolve the helper provider (Groq when available), run one completion, and
 * — if the provider is rate-limited — transparently retry on the built-in
 * model. Used by the small single-shot AI helpers (selector heal, gap-fill,
 * popup review, consent).
 */
async function completeSmart(
  system: string,
  prompt: string,
  settings: Settings,
  signal: AbortSignal,
): Promise<string> {
  // Privacy default: helper prompts can embed short snippets of page markup
  // (ad candidates, overlay/banner HTML), so they run on-device whenever
  // Chrome's built-in model is ready. A cloud provider is used only when no
  // on-device model is available — disclosed in the privacy policy.
  const provider =
    (await builtinAvailability()) === 'available'
      ? 'builtin'
      : resolveHelperProvider(settings)
  const model =
    provider === 'groq' ? GROQ_HELPER_MODEL : resolveModel(provider, settings)
  try {
    await paceRequests(provider, signal)
    return await withTimeout(
      complete(provider, model, system, prompt, settings, signal),
      CHUNK_TIMEOUT_MS[provider],
    )
  } catch (error) {
    // Rate-limited or the configured model is gone → fall back to on-device AI
    // for this helper call so a stale model id never breaks a helper feature.
    if (
      (error instanceof RateLimitError ||
        error instanceof ModelUnavailableError) &&
      provider !== 'builtin'
    ) {
      return await withTimeout(
        complete('builtin', '', system, prompt, settings, signal),
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

/** OpenAI-protocol providers. jsonMode: whether response_format is safe to
 * send (many OpenRouter :free models and older Ollama builds reject it). */
const OPENAI_COMPATIBLE = {
  openai: {
    url: 'https://api.openai.com/v1/chat/completions',
    label: 'OpenAI',
    jsonMode: true,
  },
  gemini: {
    url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    label: 'Gemini',
    jsonMode: true,
  },
  groq: {
    url: 'https://api.groq.com/openai/v1/chat/completions',
    label: 'Groq',
    jsonMode: true,
  },
  openrouter: {
    url: 'https://openrouter.ai/api/v1/chat/completions',
    label: 'OpenRouter',
    jsonMode: false,
  },
  ollama: {
    url: 'http://localhost:11434/v1/chat/completions',
    label: 'Ollama',
    jsonMode: false,
  },
  openclaw: {
    // Placeholder — the real URL comes from settings.openclawUrl (the
    // gateway port is user-configurable).
    url: 'http://127.0.0.1:18789/v1/chat/completions',
    label: 'OpenClaw',
    jsonMode: false,
  },
} as const

/**
 * Model to use for `provider`. The user's model override only applies to the
 * provider they actually selected — a fallback/helper provider must use its
 * own default (a Gemini model id sent to Groq is a guaranteed 404).
 */
function resolveModel(provider: LlmProvider, settings: Settings): string {
  if (provider === 'builtin') return ''
  if (provider === settings.llmProvider && settings.model.trim()) {
    return settings.model.trim()
  }
  return DEFAULT_MODELS[provider]
}

function complete(
  provider: LlmProvider,
  model: string,
  system: string,
  prompt: string,
  settings: Settings,
  signal: AbortSignal,
): Promise<string> {
  switch (provider) {
    case 'anthropic':
      return completeAnthropic(model, system, prompt, settings, signal)
    case 'builtin':
      return completeBuiltin(system, prompt, signal)
    default:
      return completeOpenAiCompatible(
        provider,
        model,
        system,
        prompt,
        settings,
        signal,
      )
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
  model: string,
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
      model,
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

/** OpenAI-compatible chat-completions call: OpenAI, Gemini's `/v1beta/openai/`
 * endpoint, Groq, OpenRouter, and a local Ollama server all speak it. */
async function completeOpenAiCompatible(
  provider: keyof typeof OPENAI_COMPATIBLE,
  model: string,
  system: string,
  prompt: string,
  settings: Settings,
  signal: AbortSignal,
): Promise<string> {
  const { url: defaultUrl, label, jsonMode } = OPENAI_COMPATIBLE[provider]
  const url =
    provider === 'openclaw'
      ? settings.openclawUrl.trim() || defaultUrl
      : defaultUrl
  const key =
    provider === 'ollama' ? '' : (settings.apiKeys[provider] ?? '').trim()
  const response = await fetch(url, {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify({
      model,
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
    }),
  })
  if (!response.ok) {
    const body = await safeText(response)
    throwForStatus(provider, response, body)
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
  // 'downloadable'/'downloading': create() kicks off / waits for the model
  // download. We used to pass { temperature: 0.1, topK: 3 } for
  // near-deterministic output, but Chrome deprecated those create() options
  // (they warn now and may be removed); the model defaults are fine since
  // sponsor-detection output is validated/parsed downstream. Pass the abort
  // signal so an in-flight prompt is cancelled on navigation.
  const session = await LanguageModel.create({ signal })
  try {
    if (signal.aborted) throw new LlmError('Aborted')
    return await session.prompt(`${system}\n\n${prompt}`, { signal })
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
  // Model id gone (retired snapshot, bad Custom id): providers signal this as a
  // 404, or a 400/403 whose body names the model. Distinguish it from other
  // 4xx (auth, bad request) so callers can retry on a working model rather than
  // surfacing a dead-model error to the user.
  const modelGone =
    /model/i.test(body) &&
    /not found|not available|no longer available|not supported|does not exist|unknown model|deprecated|decommission/i.test(
      body,
    )
  if (response.status === 404 || ((response.status === 400 || response.status === 403) && modelGone)) {
    throw new ModelUnavailableError(`${provider} model unavailable: ${body.slice(0, 160)}`)
  }
}
