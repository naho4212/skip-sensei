import { getSettings, onSettingsChanged } from './storage'

/**
 * Anti-adblock scriptlet layer (service-worker side). Registers or unregisters
 * the MAIN-world scriptlet bundle (public/scriptlets-main.js) via
 * chrome.scripting. The bundle neutralizes adblock-detection and ad-reinsertion
 * with uBO-style scriptlets (set-constant, spoof-css, abort-on-property-read,
 * prevent-setTimeout/addEventListener) targeted per-hostname by its embedded
 * config.
 *
 * Permission reality: registerContentScripts can only match hosts we hold
 * permission for. YouTube is deliberately EXCLUDED (its ad path is handled by
 * the finely-tuned pruner + reactive ad engine — we don't want untested
 * scriptlets there). That leaves the broad web, which requires the optional
 * all-sites host permission — a base permission since 0.3.15 (the check
 * remains in case a user revokes site access in chrome://extensions), so
 * this layer activates at install when defuseAntiAdblock is on; it also re-activates
 * automatically. It must run in the PAGE world at document_start, which — like
 * the pruner — rules out a statically declared manifest content script;
 * it's registered directly via chrome.scripting with world:'MAIN'.
 */

const SCRIPT_ID = 'skip-sensei-scriptlets'

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

async function hasBroadHostPermission(): Promise<boolean> {
  try {
    return await chrome.permissions.contains({ origins: ['*://*/*'] })
  } catch {
    return false
  }
}

export async function syncScriptletRegistration(): Promise<void> {
  const settings = await getSettings()
  const shouldRun =
    settings.masterEnabled &&
    settings.blockAllAds &&
    settings.defuseAntiAdblock &&
    (await hasBroadHostPermission())

  const registered = await isRegistered()
  try {
    if (shouldRun && !registered) {
      await chrome.scripting.registerContentScripts([
        {
          id: SCRIPT_ID,
          js: ['scriptlets-main.js'],
          matches: ['*://*/*'],
          // YouTube is handled by the pruner + ad engine; keep scriptlets off it.
          excludeMatches: ['*://*.youtube.com/*'],
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
    // registration API unavailable / permission just revoked — non-fatal; the
    // network + cosmetic layers still run.
  }
}

/**
 * Enforce on startup, install, settings change, AND host-permission changes
 * (the broad-web layer switches on the moment all-sites access is granted). The first
 * sync is driven by the service worker's cold-start gate (see lifecycle.ts).
 */
export function initScriptletRegistration(): void {
  chrome.runtime.onInstalled.addListener(() => void syncScriptletRegistration())
  chrome.runtime.onStartup.addListener(() => void syncScriptletRegistration())
  onSettingsChanged(() => void syncScriptletRegistration())
  chrome.permissions.onAdded.addListener(() => void syncScriptletRegistration())
  chrome.permissions.onRemoved.addListener(
    () => void syncScriptletRegistration(),
  )
}
