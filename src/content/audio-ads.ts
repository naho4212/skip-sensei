import { getSettings, onSettingsChanged } from '../storage'
import type { Message, Settings } from '../types'

/**
 * Audio-ad muting for the Spotify web player (open.spotify.com).
 *
 * Layer 2 of streaming-ad handling. Layer 1 is the `streaming` DNR ruleset
 * (build-rulesets.mjs): with the ad-decisioning endpoint blocked the player
 * is normally never handed an ad. This script is the fallback for what leaks
 * through — an ad that IS playing can't be skipped (Spotify disables the
 * controls server-side for free accounts), but it can be silenced. The tab is
 * muted for exactly the ad's duration and unmuted the moment a track resumes.
 *
 * Muting is TAB-level via the service worker (chrome.tabs.update), not the
 * <audio> element: Spotify drives playback through EME/MSE and re-creates
 * media elements freely, so element-level muting is racy; the tab flag is
 * one bit Chrome owns. The worker only ever unmutes a tab it muted itself
 * (mutedInfo.extensionId), so a user's own mute is never touched.
 *
 * Detection is deliberately narrow: the now-playing widget's TITLE must be
 * exactly the localized word "Advertisement", or the document title must lead
 * with it. Substring matching is banned project-wide for a reason (a track
 * called "Advertising Space" must not be muted); exact-match on the title
 * slot is the one place the word is unambiguous.
 */

/** Spotify's localized ad title, exact match, case-insensitive. */
const AD_TITLES = new Set(
  [
    'Advertisement',
    'Anuncio',
    'Anúncio',
    'Publicité',
    'Werbung',
    'Pubblicità',
    'Advertentie',
    'Reklam',
    'Reklama',
    'Реклама',
    '広告',
    '광고',
    '广告',
    '廣告',
  ].map((s) => s.toLowerCase()),
)

const WIDGET_SELECTOR = '[data-testid="now-playing-widget"]'
const TITLE_SELECTOR = '[data-testid="context-item-info-title"]'
const POLL_MS = 1000
/** Hard ceiling on one mute: a Spotify ad break is ≤ ~90s. Past this the
 * signal is assumed stuck (paused mid-ad, DOM drift) and the tab is released;
 * it re-arms only after the signal has cleared once. */
const MAX_MUTE_MS = 180_000
/** Keep the mute this long after the ad signal clears. Spotify serves ads in
 * pods (two back-to-back were observed live); if the widget flickers to a
 * track title between them the tab would unmute for the gap and the second
 * ad's first second would be audible. A real track resuming costs 1.5s of
 * silence at its very start — the better trade. */
const RELEASE_HOLD_MS = 1500

let settings: Settings | null = null
let enabled = false
let muted = false
let mutedAt = 0
let poisoned = false
/** When the ad signal last went clear while muted (0 = not pending). */
let clearSince = 0
let timer: ReturnType<typeof setInterval> | null = null
let observer: MutationObserver | null = null

function isAllowlisted(allowlist: string[]): boolean {
  const host = location.hostname
  const bare = host.replace(/^www\./, '')
  return allowlist.includes(host) || allowlist.includes(bare)
}

function shouldRun(s: Settings): boolean {
  return s.masterEnabled && s.blockAllAds && !isAllowlisted(s.allowlist)
}

function isAdTitle(text: string | null | undefined): boolean {
  if (!text) return false
  return AD_TITLES.has(text.trim().toLowerCase())
}

/** True while the player reports an ad in the now-playing slot. */
function adPlaying(): boolean {
  const widget = document.querySelector(WIDGET_SELECTOR)
  if (widget) {
    const title = widget.querySelector(TITLE_SELECTOR)
    if (isAdTitle(title?.textContent)) return true
    // Ads render the title as plain text (no track link) in some builds —
    // fall back to the widget's accessible name, which Spotify sets to
    // "Now playing: <title> by <artist>". Take the segment before " by ".
    // Observed live: during an ad the label is exactly "Advertisement" (no
    // "Now playing:" prefix) and the title slot shows the advertiser's name.
    const label = widget.getAttribute('aria-label')
    if (label) {
      if (isAdTitle(label)) return true
      const afterColon = label.slice(label.indexOf(':') + 1)
      const [first] = afterColon.split(/\s+by\s+/i)
      if (isAdTitle(first)) return true
    }
  }
  // Document title. Observed live (Aug 2026): "Spotify – Advertisement" —
  // the word can sit in ANY segment, so every segment is checked, not the
  // first (which is the ad's brand name in the widget, and "Spotify" here).
  return document.title.split(/\s+[•\-–|]\s+/).some(isAdTitle)
}

function send<T = unknown>(message: Message): Promise<T | null> {
  try {
    return chrome.runtime.sendMessage(message).catch(() => null)
  } catch {
    // Extension reloaded under us: this script is orphaned. Stop cleanly.
    stop()
    return Promise.resolve(null)
  }
}

async function setMuted(on: boolean) {
  if (on === muted) return
  const applied = await send<boolean>({ type: 'skipSensei:muteTab', muted: on })
  if (on) {
    // The worker declines when the user muted the tab themselves — then
    // there's nothing for us to own, and nothing to unmute later either.
    if (applied !== true) return
    muted = true
    mutedAt = Date.now()
    // Observable from the page (tab mute state isn't): lets a live check
    // confirm the muter fired without opening the activity log.
    document.documentElement.setAttribute('data-ad-sensei-muted', '1')
  } else {
    const seconds = ((Date.now() - mutedAt) / 1000).toFixed(1)
    muted = false
    document.documentElement.removeAttribute('data-ad-sensei-muted')
    void send({
      type: 'skipSensei:event',
      kind: 'audio_ad_muted',
      fields: { seconds },
    })
  }
}

function tick() {
  if (!enabled) return
  const ad = adPlaying()
  const now = Date.now()
  if (!ad) {
    poisoned = false
    if (muted) {
      if (clearSince === 0) clearSince = now
      if (now - clearSince >= RELEASE_HOLD_MS) {
        clearSince = 0
        void setMuted(false)
      }
    }
    return
  }
  clearSince = 0
  if (poisoned) return
  if (muted && now - mutedAt > MAX_MUTE_MS) {
    poisoned = true
    void setMuted(false)
    return
  }
  if (!muted) void setMuted(true)
}

function start() {
  if (enabled) return
  enabled = true
  timer = setInterval(tick, POLL_MS)
  // React on the same tick the track changes rather than up to a second
  // later — the difference between a muted ad and a muted first second of
  // the next song. Observe the whole player bar: the widget is re-mounted
  // between items, so observing the widget node itself would go stale.
  observer = new MutationObserver(() => tick())
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributeFilter: ['aria-label'],
  })
  tick()
}

function stop() {
  if (!enabled) return
  enabled = false
  if (timer) clearInterval(timer)
  timer = null
  observer?.disconnect()
  observer = null
  clearSince = 0
  if (muted) void setMuted(false)
}

function sync() {
  if (!settings) return
  if (shouldRun(settings)) start()
  else stop()
}

// Never leave a tab muted behind us: the flag survives navigation, so a user
// who clicks away mid-ad would otherwise land on a silent page. The worker
// also releases on navigation, this is the fast path.
window.addEventListener('pagehide', () => {
  if (muted) void setMuted(false)
})

void getSettings().then((s) => {
  settings = s
  sync()
})
onSettingsChanged((s) => {
  settings = s
  sync()
})
