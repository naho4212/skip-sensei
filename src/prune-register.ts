import { getSettings, onSettingsChanged } from './storage'

/**
 * Aggressive-mode registration (service-worker side). Registers or
 * unregisters the MAIN-world YouTube ad pruner (public/prune-main.js) via
 * chrome.scripting based on the aggressivePruning setting.
 *
 * Why runtime registration instead of a static manifest content script:
 *  - It must run in the PAGE world at document_start (to trap
 *    ytInitialPlayerResponse before YouTube's inline scripts). CRXJS wraps
 *    every manifest content script in an ASYNC module loader, which lands
 *    too late for the initial page load.
 *  - Registration doubles as the on/off gate — the script is simply absent
 *    when aggressive mode is off, so there's no page-world runtime cost and
 *    nothing to detect when the user hasn't opted in.
 */

const SCRIPT_ID = 'skip-sensei-aggressive-pruner'

async function isRegistered(): Promise<boolean> {
  try {
    const scripts = await chrome.scripting.getRegisteredContentScripts({
      ids: [SCRIPT_ID],
    })
    return scripts.length > 0
  } catch {
    return false
  }
}

export async function syncPruneRegistration(): Promise<void> {
  const settings = await getSettings()
  const shouldRun =
    settings.masterEnabled &&
    settings.adEngineEnabled &&
    settings.aggressivePruning

  const registered = await isRegistered()
  try {
    if (shouldRun && !registered) {
      await chrome.scripting.registerContentScripts([
        {
          id: SCRIPT_ID,
          js: ['prune-main.js'],
          matches: ['*://*.youtube.com/*'],
          runAt: 'document_start',
          world: 'MAIN',
          persistAcrossSessions: true,
          allFrames: false,
        },
      ])
    } else if (!shouldRun && registered) {
      await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] })
    }
  } catch {
    // registration API unavailable or transient failure — reactive skipping
    // still handles ads, so this is non-fatal.
  }
}

/** Enforce on startup, install, and whenever settings change. */
export function initPruneRegistration(): void {
  chrome.runtime.onInstalled.addListener(() => void syncPruneRegistration())
  chrome.runtime.onStartup.addListener(() => void syncPruneRegistration())
  onSettingsChanged(() => void syncPruneRegistration())
  void syncPruneRegistration()
}
