import {
  AD_SHOWING_CLASSES,
  ENFORCEMENT_MESSAGE,
  MODAL_BACKDROP,
  OVERLAY_ADS,
  OVERLAY_CLOSE_BUTTONS,
  PAUSE_OVERLAY_ADS,
  PLAYER,
  POPUP_DIALOG,
  SKIP_BUTTONS,
  VIDEO,
} from '../selectors'
import type { AdSkipMethod } from '../types'

/**
 * Ad Engine: detects YouTube-served ads on the current watch page and
 * neutralizes them. One instance per watch page; SPA navigation tears it
 * down and creates a fresh one.
 *
 * Detection is driven by a MutationObserver on #movie_player (class changes
 * flag ad playback; subtree changes surface skip buttons and overlays) plus a
 * low-frequency interval as a safety net for anything the observer misses.
 */
export class AdEngine {
  private observer: MutationObserver | null = null
  private fallbackTimer: number | null = null
  private player: HTMLElement | null = null
  /** True while we're burning through the current un-skippable ad. */
  private fastForwarding = false
  private attachRetryTimer: number | null = null
  /** check() re-fires while the skip button lingers; count one skip per ad, not per click. */
  private lastSkipButtonCountAt = 0

  constructor(private onSkip: (method: AdSkipMethod) => void) {}

  start() {
    this.attachWhenPlayerExists()
  }

  stop() {
    this.observer?.disconnect()
    this.observer = null
    if (this.fallbackTimer !== null) clearInterval(this.fallbackTimer)
    this.fallbackTimer = null
    if (this.attachRetryTimer !== null) clearTimeout(this.attachRetryTimer)
    this.attachRetryTimer = null
    this.player = null
    this.fastForwarding = false
  }

  get isActive(): boolean {
    return this.observer !== null
  }

  /** The player renders asynchronously after SPA navigation; poll until it exists. */
  private attachWhenPlayerExists(attempt = 0) {
    const player = document.querySelector<HTMLElement>(PLAYER)
    if (!player) {
      if (attempt < 40) {
        this.attachRetryTimer = window.setTimeout(
          () => this.attachWhenPlayerExists(attempt + 1),
          250,
        )
      }
      return
    }
    this.player = player
    this.observer = new MutationObserver(() => this.check())
    this.observer.observe(player, {
      attributes: true,
      attributeFilter: ['class'],
      childList: true,
      subtree: true,
    })
    // Safety net: catches states the observer can miss (e.g. a skip button
    // that exists but only becomes clickable later without a DOM mutation).
    this.fallbackTimer = window.setInterval(() => this.check(), 1000)
    this.check()
  }

  private check() {
    if (!this.player) return

    this.dismissEnforcementWall()
    this.removeOverlayAds()
    this.dismissPauseOverlays()

    const adShowing = AD_SHOWING_CLASSES.some((cls) =>
      this.player!.classList.contains(cls),
    )
    if (!adShowing) {
      this.fastForwarding = false
      return
    }

    if (this.clickSkipButton()) {
      this.fastForwarding = false
      return
    }
    this.fastForwardAd()
  }

  private clickSkipButton(): boolean {
    for (const selector of SKIP_BUTTONS) {
      const button = this.player!.querySelector<HTMLElement>(selector)
      if (button && button.offsetParent !== null) {
        button.click()
        const now = Date.now()
        if (now - this.lastSkipButtonCountAt > 3000) {
          this.lastSkipButtonCountAt = now
          this.onSkip('skip-button')
        }
        return true
      }
    }
    return false
  }

  /**
   * No skip button (yet): jump the ad video to its end. Guarded so a single
   * multi-second ad counts as one skip even though check() fires repeatedly.
   */
  private fastForwardAd() {
    const video = document.querySelector<HTMLVideoElement>(VIDEO)
    if (!video || !Number.isFinite(video.duration) || video.duration <= 0)
      return
    if (video.currentTime >= video.duration - 0.2) return

    video.currentTime = video.duration
    if (!this.fastForwarding) {
      this.fastForwarding = true
      this.onSkip('fast-forward')
    }
  }

  /**
   * Dismiss YouTube's "Video player will be blocked" anti-ad-blocker wall:
   * remove the modal + backdrop, restore page scroll, and resume the video it
   * paused. Runs every check() so a wall that appears mid-session is cleared.
   */
  private dismissEnforcementWall() {
    const message = document.querySelector(ENFORCEMENT_MESSAGE)
    if (!message) return

    document.querySelectorAll(POPUP_DIALOG).forEach((dialog) => {
      if (dialog.querySelector(ENFORCEMENT_MESSAGE)) dialog.remove()
    })
    message.closest('ytd-popup-container')?.remove()
    message.remove()
    document.querySelectorAll(MODAL_BACKDROP).forEach((el) => el.remove())

    // YouTube locks scroll and pauses playback behind the wall; undo both.
    document.documentElement.style.overflow = ''
    document.body.style.overflow = ''
    const video = document.querySelector<HTMLVideoElement>(VIDEO)
    if (video && video.paused) void video.play().catch(() => {})
  }

  private removeOverlayAds() {
    for (const selector of OVERLAY_CLOSE_BUTTONS) {
      document
        .querySelectorAll<HTMLElement>(selector)
        .forEach((el) => el.click())
    }
    let removed = false
    for (const selector of OVERLAY_ADS) {
      document.querySelectorAll(selector).forEach((el) => {
        el.remove()
        removed = true
      })
    }
    if (removed) this.onSkip('overlay-removed')
  }

  private dismissPauseOverlays() {
    let removed = false
    for (const selector of PAUSE_OVERLAY_ADS) {
      document.querySelectorAll(selector).forEach((el) => {
        el.remove()
        removed = true
      })
    }
    if (removed) this.onSkip('pause-overlay-dismissed')
  }
}
