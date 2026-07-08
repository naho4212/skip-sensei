/**
 * Aggressive-mode reporter (ISOLATED world, document_start on youtube.com).
 *
 * The actual pruning is public/prune-main.js, injected into the PAGE world by
 * the service worker via chrome.scripting when aggressive mode is on. This
 * script's only job is to relay the pruner's "ads-pruned" postMessage to the
 * service worker so pruning shows up in the activity log. (The page world
 * can't reach chrome.runtime; the isolated world can.)
 */

/** One activity-log entry per pruning burst, not per pruned response. */
const REPORT_DEBOUNCE_MS = 10_000

let lastReportAt = 0
window.addEventListener('message', (event) => {
  if (event.source !== window) return
  const data = event.data as { source?: string; type?: string } | null
  if (data?.source !== 'skip-sensei' || data?.type !== 'ads-pruned') return
  const now = Date.now()
  if (now - lastReportAt < REPORT_DEBOUNCE_MS) return
  lastReportAt = now
  try {
    chrome.runtime
      .sendMessage({ type: 'skipSensei:adSkipped', method: 'pruned' })
      .catch(() => {})
  } catch {
    // orphaned after an extension reload — nothing to report to
  }
})
