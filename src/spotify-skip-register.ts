import { getSettings, onSettingsChanged } from './storage'

/**
 * Spotify audio-ad SKIP registration (service-worker side). Registers or
 * unregisters the MAIN-world state-machine rewriter (public/spotify-skip-main.js)
 * via chrome.scripting based on the BETA `spotifySkipAds` setting.
 *
 * Same rationale as the YouTube pruner (see prune-register.ts): the skip
 * engine must hook window.fetch/WebSocket in the PAGE world at document_start,
 * before Spotify's own scripts create the socket. A statically declared
 * content script can't reach the MAIN world synchronously that early;
 * registering directly with world:'MAIN' does. Registration doubles as the
 * on/off gate — the script is simply absent when the beta is off, so there's
 * no page-world cost and nothing to detect for users who never opted in.
 *
 * The tab-mute muter (src/content/audio-ads.ts) is independent and stays on as
 * the fallback: when skip is off it silences ads; when skip is on it silences
 * anything skip misses (a brand-new ad shape, a Spotify state-machine change).
 */

const SCRIPT_ID = 'skip-sensei-spotify-skip'

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

export async function syncSpotifySkipRegistration(): Promise<void> {
  const settings = await getSettings()
  const shouldRun =
    settings.masterEnabled && settings.blockAllAds && settings.spotifySkipAds

  const registered = await isRegistered()
  try {
    if (shouldRun && !registered) {
      await chrome.scripting.registerContentScripts([
        {
          id: SCRIPT_ID,
          js: ['spotify-skip-main.js'],
          matches: ['https://open.spotify.com/*'],
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
    // registration API unavailable or transient failure — the muter still
    // handles Spotify ads, so this is non-fatal.
  }
}

/** Enforce on install, startup, and settings change (mirrors prune-register). */
export function initSpotifySkipRegistration(): void {
  chrome.runtime.onInstalled.addListener(() => void syncSpotifySkipRegistration())
  chrome.runtime.onStartup.addListener(() => void syncSpotifySkipRegistration())
  onSettingsChanged(() => void syncSpotifySkipRegistration())
}
