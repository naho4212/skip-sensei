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

const INSTALL_ID_KEY = 'skipSensei.installId'
const ERROR_BUDGET_KEY = 'skipSensei.errorBudget'
/** Max error reports per rolling hour, and dedupe of repeats within it. */
const MAX_ERRORS_PER_HOUR = 5

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
    const { telemetryEnabled, llmProvider } = await getSettings()
    if (!telemetryEnabled) return

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
