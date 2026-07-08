import { getSettings, onSettingsChanged } from '../storage'
import type { Settings } from '../types'

/**
 * YouTube annoyance removers (cosmetic/behavioral, independent of ad blocking):
 *  - hide the Shorts shelves + nav entries,
 *  - hide end-screen suggestion cards and turn off autoplay-of-next,
 *  - auto-dismiss the "Video paused. Continue watching?" idle prompt.
 * Each is gated on its own setting; nothing runs unless a toggle is on.
 */

const STYLE_ID = 'skip-sensei-yt-annoyances'

const SHORTS_CSS =
  'ytd-rich-shelf-renderer[is-shorts],' +
  'ytd-reel-shelf-renderer,' +
  'ytd-rich-section-renderer:has(ytd-rich-shelf-renderer[is-shorts]),' +
  'ytd-guide-entry-renderer:has(a[title="Shorts"]),' +
  'ytd-mini-guide-entry-renderer:has(a[title="Shorts"])' +
  '{display:none!important}'

// End-screen cards shown over the video in its final seconds + the full
// end-screen suggestion grid.
const ENDCARDS_CSS =
  '.ytp-ce-element,.ytp-endscreen-content{display:none!important}'

function applyStyles(s: Settings) {
  const parts: string[] = []
  if (s.ytHideShorts) parts.push(SHORTS_CSS)
  if (s.ytDisableEndCards) parts.push(ENDCARDS_CSS)
  const existing = document.getElementById(STYLE_ID)
  if (parts.length === 0) {
    existing?.remove()
    return
  }
  const style = existing ?? document.createElement('style')
  style.id = STYLE_ID
  style.textContent = parts.join('')
  if (!existing) (document.head ?? document.documentElement).appendChild(style)
}

let lastAutonavClickAt = 0

function behavioralTick(s: Settings) {
  // "Video paused. Continue watching?" — click its confirm button so playback
  // never silently stalls on a long video.
  if (s.ytDismissStillWatching) {
    for (const dialog of document.querySelectorAll<HTMLElement>(
      'yt-confirm-dialog-renderer, tp-yt-paper-dialog',
    )) {
      if (dialog.offsetParent === null) continue
      if (!/still watching|continue watching|video paused/i.test(dialog.textContent ?? ''))
        continue
      const confirm =
        dialog.querySelector<HTMLElement>('#confirm-button') ??
        Array.from(
          dialog.querySelectorAll<HTMLElement>('button, tp-yt-paper-button'),
        ).find(
          (b) =>
            b.offsetParent !== null &&
            /yes|continue|resume|still/i.test(
              `${b.textContent ?? ''} ${b.getAttribute('aria-label') ?? ''}`,
            ),
        )
      confirm?.click()
    }
  }

  // Turn off autoplay-of-next when it's on (checked). Throttled so a stubborn
  // re-enable can't turn into a click loop.
  if (s.ytDisableEndCards) {
    const toggle = document.querySelector<HTMLElement>(
      '.ytp-autonav-toggle-button[aria-checked="true"]',
    )
    const now = Date.now()
    if (toggle && now - lastAutonavClickAt > 3000) {
      lastAutonavClickAt = now
      toggle.click()
    }
  }
}

let settings: Settings | null = null
let timer: number | null = null

function syncTimer() {
  const need =
    settings && (settings.ytDismissStillWatching || settings.ytDisableEndCards)
  if (need && timer === null) {
    timer = window.setInterval(() => {
      if (settings) behavioralTick(settings)
    }, 2000)
  } else if (!need && timer !== null) {
    clearInterval(timer)
    timer = null
  }
}

export function initYouTubeAnnoyances() {
  void getSettings().then((s) => {
    settings = s
    applyStyles(s)
    syncTimer()
  })
  onSettingsChanged((s) => {
    settings = s
    applyStyles(s)
    syncTimer()
  })
}
