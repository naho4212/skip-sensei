import { getSettings, onSettingsChanged } from './storage'

/**
 * Broad-web cosmetic registration (service-worker side). The cosmetic content
 * script (src/content/cosmetic.ts) is declared statically in the manifest for
 * youtube.com ONLY — YouTube display-ad hiding is a default-on feature and
 * youtube.com host access is a required permission, so that injection needs no
 * opt-in and adds no install-time warning.
 *
 * Applying cosmetic filtering to the rest of the web is the "Block all ads"
 * (and related) opt-in. Rather than declare a static `<all_urls>` content
 * script — which forces every install to accept "read and change all your data
 * on all websites" — we register the SAME built script at runtime, on the
 * broad all-sites match, only once the user has both enabled a web-cosmetic feature AND granted the
 * optional all-sites host permission. Base installs stay YouTube-scoped.
 *
 * The built file paths are content-hashed by the bundler, so we read them back
 * from the manifest's own youtube cosmetic entry instead of hardcoding them —
 * whatever ships for YouTube is exactly what we replay onto the broad web.
 */

const SCRIPT_ID = 'skip-sensei-cosmetic-web'

/** Pull the built cosmetic script's js files out of the youtube content-script entry. */
function cosmeticScriptFiles(): string[] {
  const entries = chrome.runtime.getManifest().content_scripts ?? []
  for (const entry of entries) {
    const js = entry.js ?? []
    if (js.some((f) => /cosmetic/.test(f))) return js
  }
  return []
}

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

export async function syncCosmeticRegistration(): Promise<void> {
  const settings = await getSettings()
  // Any feature that needs cosmetic.ts running off YouTube: generic ad hiding,
  // cosmetic hides for cookie/social/popup, or the AI page-cleanup helpers.
  const wantsWebCosmetic =
    settings.blockAllAds ||
    settings.blockCookieNotices ||
    settings.blockSocial ||
    settings.blockPopups
  const shouldRun =
    settings.masterEnabled &&
    wantsWebCosmetic &&
    (await hasBroadHostPermission())

  const files = cosmeticScriptFiles()
  const registered = await isRegistered()
  try {
    if (shouldRun && !registered && files.length > 0) {
      await chrome.scripting.registerContentScripts([
        {
          id: SCRIPT_ID,
          js: files,
          matches: ['*://*/*'],
          // YouTube is already covered by the static manifest entry.
          excludeMatches: ['*://*.youtube.com/*'],
          runAt: 'document_start',
          persistAcrossSessions: true,
          allFrames: true,
        },
      ])
    } else if (!shouldRun && registered) {
      await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] })
    }
  } catch {
    // Registration API unavailable / permission just revoked — non-fatal; the
    // YouTube layer and network blocking still run.
  }
}

/**
 * Enforce on startup, install, settings change, AND host-permission changes
 * (the broad-web layer switches on the moment all-sites access is granted).
 */
export function initCosmeticRegistration(): void {
  chrome.runtime.onInstalled.addListener(() => void syncCosmeticRegistration())
  chrome.runtime.onStartup.addListener(() => void syncCosmeticRegistration())
  onSettingsChanged(() => void syncCosmeticRegistration())
  chrome.permissions.onAdded.addListener(() => void syncCosmeticRegistration())
  chrome.permissions.onRemoved.addListener(
    () => void syncCosmeticRegistration(),
  )
}
