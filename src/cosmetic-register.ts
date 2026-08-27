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
 * broad all-sites match, once a web-cosmetic feature is on (all-sites host
 * access is a base permission since 0.3.15; the contains() check stays as a
 * cheap guard against a user revoking site access in chrome://extensions).
 *
 * The built file paths are content-hashed by the bundler, so we read them back
 * from the manifest's own youtube cosmetic entry instead of hardcoding them —
 * whatever ships for YouTube is exactly what we replay onto the broad web.
 */

const SCRIPT_ID = 'skip-sensei-cosmetic-web'

/** Pull a built content script's js files out of the manifest entry whose
 *  file name matches — paths are content-hashed, so never hardcode them. */
export function contentScriptFiles(nameRe: RegExp): string[] {
  const entries = chrome.runtime.getManifest().content_scripts ?? []
  for (const entry of entries) {
    const js = entry.js ?? []
    if (js.some((f) => nameRe.test(f))) return js
  }
  return []
}
const cosmeticScriptFiles = () => contentScriptFiles(/cosmetic/)

/**
 * Run a built content script in the tabs that are ALREADY open. Content
 * scripts (static or registered) only attach on page load, so after an
 * install/update every open tab keeps running the previous version's script —
 * or, for a brand-new script, nothing at all. That is exactly how the Spotify
 * muter "didn't work" on its first live test: the tab predated the build.
 * Injecting into existing tabs makes an update take effect without a reload.
 * Failures are per-tab and swallowed (chrome:// pages, discarded tabs, a
 * frame that went away mid-call).
 */
export async function injectIntoOpenTabs(
  files: string[],
  urlPatterns: string[],
  opts: { allFrames?: boolean; exclude?: RegExp } = {},
): Promise<number> {
  if (files.length === 0) return 0
  let done = 0
  let tabs: chrome.tabs.Tab[] = []
  try {
    tabs = await chrome.tabs.query({ url: urlPatterns, discarded: false })
  } catch {
    return 0
  }
  for (const tab of tabs) {
    if (tab.id === undefined) continue
    if (opts.exclude && tab.url && opts.exclude.test(tab.url)) continue
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: opts.allFrames ?? false },
        files,
      })
      done++
    } catch {
      // per-tab, non-fatal
    }
  }
  return done
}

/** After install/update: replay the web cosmetic layer into open non-YouTube
 *  tabs when it's registered (YouTube tabs get the ↻ badge — the ad engine
 *  there is stateful and needs a real reload), and the Spotify muter into
 *  open web-player tabs. */
export async function injectRegisteredIntoOpenTabs(): Promise<void> {
  if (await isRegistered()) {
    await injectIntoOpenTabs(cosmeticScriptFiles(), ['http://*/*', 'https://*/*'], {
      allFrames: true,
      exclude: /^https?:\/\/([^/]+\.)?youtube\.com\//,
    })
  }
  await injectIntoOpenTabs(contentScriptFiles(/audio-ads/), [
    '*://open.spotify.com/*',
  ])
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
