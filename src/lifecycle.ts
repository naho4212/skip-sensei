/**
 * Service-worker lifecycle helpers.
 *
 * MV3 tears the service worker down when it looks idle and re-evaluates the
 * module on the next event. DNR ruleset state and chrome.scripting content-
 * script registrations PERSIST across those restarts, so re-deriving them on
 * every wake is wasted work (it was the single biggest per-wake cost).
 *
 * We use storage.session as a "warm" flag: it survives SW restarts but is
 * cleared when the browser closes (and on extension reload/update). Present →
 * this is a mid-session wake, skip the expensive cold-start sync. Absent →
 * a genuine cold start (browser launch / install / update): do the full sync
 * once and set the flag.
 */

const WARM_FLAG = 'skipSensei.swWarm'
const GOOD_START = 'skipSensei.goodStart'

/** Resolves true exactly once per browser session — the first SW start. */
export async function isColdStart(): Promise<boolean> {
  try {
    const got = await chrome.storage.session.get(WARM_FLAG)
    if (got[WARM_FLAG]) return false
    await chrome.storage.session.set({ [WARM_FLAG]: true })
    return true
  } catch {
    // storage.session unavailable → treat as cold so we stay correct.
    return true
  }
}

/**
 * Run one-time cold-start initialization behind a self-heal guard. If it throws
 * (a transient API/storage failure during startup left blocking half-applied),
 * reload the worker ONCE to retry from a clean slate. A `goodStart` sentinel in
 * local storage breaks reload loops: a second consecutive failure gives up and
 * lets the reactive paths carry on rather than reloading forever.
 */
export async function runColdStart(init: () => Promise<void>): Promise<void> {
  try {
    await init()
    await chrome.storage.local.set({ [GOOD_START]: true })
  } catch (error) {
    const got = await chrome.storage.local.get(GOOD_START)
    // healthy = the previous start succeeded (sentinel true or absent). If so
    // this is the first failure, and a reload may clear a transient condition.
    const healthy = got[GOOD_START] !== false
    await chrome.storage.local.set({ [GOOD_START]: false })
    if (healthy) {
      chrome.runtime.reload()
      return
    }
    // Second failure in a row — stop reloading; surface it and move on.
    throw error
  }
}
