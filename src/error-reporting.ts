import { getSettings } from './storage'

/**
 * Privacy-safe error reporting (runs in the service worker). Usage analytics
 * intentionally do NOT exist here — Chrome Web Store stats cover installs and
 * versions; this only phones home when something breaks.
 *
 * What a report contains: extension version, coarse browser tag
 * ("Chrome/138…"), active provider name, error class, scrubbed message,
 * scrubbed extension stack, a short context label, and a random UUID
 * generated locally (so "one user hit this 50 times" is distinguishable from
 * "50 users hit this once"). Never URLs, video ids, API keys, device ids, or
 * anything personal. Every send is fire-and-forget and swallowed on failure.
 *
 * Users can turn this off in options ("Share anonymous error reports").
 */

const ENDPOINT = 'https://landing-beta-three-23.vercel.app/api/error'
const EVENT_ENDPOINT = 'https://landing-beta-three-23.vercel.app/api/event'

const INSTALL_ID_KEY = 'skipSensei.installId'
const ERROR_BUDGET_KEY = 'skipSensei.errorBudget'
const EVENT_BUDGET_KEY = 'skipSensei.eventBudget'
/** Max error reports per rolling hour, and dedupe of repeats within it. */
const MAX_ERRORS_PER_HOUR = 5
/** Operational events are cheaper/rarer than errors but allow a few more. */
const MAX_EVENTS_PER_HOUR = 20

async function getInstallId(): Promise<string> {
  const result = await chrome.storage.local.get(INSTALL_ID_KEY)
  const existing = result[INSTALL_ID_KEY]
  if (typeof existing === 'string' && existing) return existing
  const id = crypto.randomUUID()
  await chrome.storage.local.set({ [INSTALL_ID_KEY]: id })
  return id
}

/** Strip anything secret-shaped from error text before it leaves the browser.
 * API keys leak into provider error bodies (e.g. "Gemini API 400: …key…"). */
function scrub(text: string, max: number): string {
  return text
    .replace(/sk-(ant-)?[A-Za-z0-9_-]{8,}/g, '[key]')
    .replace(/AIza[A-Za-z0-9_-]{10,}/g, '[key]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [key]')
    .replace(/[A-Za-z0-9+/_-]{40,}/g, '[token]')
    .replace(/chrome-extension:\/\/[a-p]{32}/g, 'ext:/')
    .slice(0, max)
}

/** Coarse browser tag, e.g. "Chrome/138.0.7204.49". Never the full UA. */
function browserTag(): string {
  return navigator.userAgent.match(/Chrom(?:e|ium)\/[\d.]+/)?.[0] ?? 'unknown'
}

/**
 * Report one error. Never throws, never blocks. Rate-limited to a few per
 * hour and deduped, so a crash loop can't spam the endpoint.
 */
export async function reportError(
  context: string,
  error: unknown,
): Promise<void> {
  try {
    const { telemetryEnabled, llmProvider, localOnlyMode } = await getSettings()
    if (!telemetryEnabled || localOnlyMode) return

    const err = error instanceof Error ? error : new Error(String(error))
    if (/abort/i.test(err.message)) return // user navigation, not a defect

    // Hourly budget + dedupe (keyed by context + message prefix).
    const now = Date.now()
    const result = await chrome.storage.local.get(ERROR_BUDGET_KEY)
    const budget: { since: number; count: number; seen: string[] } = result[
      ERROR_BUDGET_KEY
    ] ?? { since: now, count: 0, seen: [] }
    if (now - budget.since > 60 * 60 * 1000) {
      budget.since = now
      budget.count = 0
      budget.seen = []
    }
    const dedupeKey = `${context}:${err.message.slice(0, 80)}`
    if (budget.count >= MAX_ERRORS_PER_HOUR || budget.seen.includes(dedupeKey))
      return
    budget.count += 1
    budget.seen.push(dedupeKey)
    await chrome.storage.local.set({ [ERROR_BUDGET_KEY]: budget })

    await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'omit',
      body: JSON.stringify({
        event: 'app_error',
        install_id: await getInstallId(),
        app_version: chrome.runtime.getManifest().version,
        timestamp: new Date().toISOString(),
        context: context.slice(0, 40),
        error_class: err.constructor?.name?.slice(0, 40) ?? 'Error',
        message: scrub(err.message, 300),
        stack: scrub(err.stack ?? '', 1000),
        provider: llmProvider,
        browser: browserTag(),
      }),
    })
  } catch {
    // Error reporting must never itself become an error source.
  }
}

/**
 * Report a non-error operational event — the signals that tell us how the
 * extension is adapting in the wild, not that it crashed. The prime example
 * is a self-heal: "YouTube renamed the skip button and the AI found the new
 * selector `X`" is exactly what we need to fold X into the hardcoded list.
 *
 * Same privacy contract as reportError: gated on the telemetry setting,
 * scrubbed, rate-limited, fire-and-forget. `fields` values are short strings
 * describing extension/YouTube structure (CSS selectors, event kinds) — never
 * URLs, video ids, titles, keys, or anything personal.
 */
export async function reportEvent(
  kind: string,
  fields: Record<string, string> = {},
): Promise<void> {
  try {
    const { telemetryEnabled, llmProvider, localOnlyMode } = await getSettings()
    if (!telemetryEnabled || localOnlyMode) return

    const now = Date.now()
    const result = await chrome.storage.local.get(EVENT_BUDGET_KEY)
    const budget: { since: number; count: number; seen: string[] } = result[
      EVENT_BUDGET_KEY
    ] ?? { since: now, count: 0, seen: [] }
    if (now - budget.since > 60 * 60 * 1000) {
      budget.since = now
      budget.count = 0
      budget.seen = []
    }

    const scrubbed: Record<string, string> = {}
    for (const [key, value] of Object.entries(fields)) {
      scrubbed[key.slice(0, 40)] = scrub(String(value), 300)
    }

    const dedupeKey = `${kind}:${Object.values(scrubbed).join('|').slice(0, 100)}`
    if (budget.count >= MAX_EVENTS_PER_HOUR || budget.seen.includes(dedupeKey))
      return
    budget.count += 1
    budget.seen.push(dedupeKey)
    await chrome.storage.local.set({ [EVENT_BUDGET_KEY]: budget })

    await fetch(EVENT_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'omit',
      body: JSON.stringify({
        event: 'app_event',
        kind: kind.slice(0, 40),
        install_id: await getInstallId(),
        app_version: chrome.runtime.getManifest().version,
        timestamp: new Date().toISOString(),
        fields: scrubbed,
        provider: llmProvider,
        browser: browserTag(),
      }),
    })
  } catch {
    // Telemetry must never itself become an error source.
  }
}

/** Catch anything nobody else caught in the service worker. */
export function initErrorReporting() {
  self.addEventListener('error', (event) => {
    void reportError('sw-uncaught', (event as ErrorEvent).error ?? event)
  })
  self.addEventListener('unhandledrejection', (event) => {
    void reportError(
      'sw-unhandled-rejection',
      (event as PromiseRejectionEvent).reason,
    )
  })
}
