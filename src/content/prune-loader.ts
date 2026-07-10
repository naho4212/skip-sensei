/**
 * Aggressive-mode reporter (ISOLATED world, document_start on youtube.com).
 *
 * The actual pruning is public/prune-main.js, injected into the PAGE world by
 * the service worker via chrome.scripting when aggressive mode is on. This
 * script's only job is to relay the pruner's "ads-pruned" postMessage to the
 * service worker so pruning shows up in the activity log. (The page world
 * can't reach chrome.runtime; the isolated world can.)
 */

// No debounce needed: the pruner dedupes per video at the source, so each
// message already represents a distinct video's ad breaks (with a count).
window.addEventListener('message', (event) => {
  if (event.source !== window) return
  const data = event.data as {
    source?: string
    type?: string
    count?: number
  } | null
  if (data?.source !== 'skip-sensei' || data?.type !== 'ads-pruned') return
  const count = typeof data.count === 'number' && data.count > 0 ? data.count : 1
  try {
    chrome.runtime
      .sendMessage({ type: 'skipSensei:adSkipped', method: 'pruned', count })
      .catch(() => {})
  } catch {
    // orphaned after an extension reload — nothing to report to
  }
})
