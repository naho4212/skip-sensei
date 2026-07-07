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
import { log } from '../log'
import { addHealedSelector, getHealedSelectors, getSettings } from '../storage'
import type { AdSkipMethod } from '../types'

/** Playback rate for burning through un-skippable ads. */
const AD_FAST_RATE = 16

/** How long an ad may play with no matching skip button before we try to self-heal. */
const HEAL_AFTER_MS = 7000

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
  /** True if we muted the video for fast-forward and must restore it. */
  private mutedForAd = false
  private attachRetryTimer: number | null = null
  /** check() re-fires while the skip button lingers; count one skip per ad, not per click. */
  private lastSkipButtonCountAt = 0
  /** Runtime skip-button selectors = hardcoded + AI-healed ones from storage. */
  private skipSelectors: string[] = [...SKIP_BUTTONS]
  /** Wall-clock when the current ad started showing (for the heal timer). */
  private adShowingSince: number | null = null
  private healInFlight = false

  constructor(private onSkip: (method: AdSkipMethod) => void) {}

  start() {
    void this.loadHealedSelectors()
    this.attachWhenPlayerExists()
  }

  /** Seed the runtime selector list with any selectors the AI healed earlier. */
  private async loadHealedSelectors() {
    const healed = (await getHealedSelectors()).skipButton ?? []
    for (const selector of healed) {
      if (!this.skipSelectors.includes(selector)) this.skipSelectors.push(selector)
    }
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
      this.endFastForward()
      this.adShowingSince = null
      this.healInFlight = false
      return
    }

    if (this.adShowingSince === null) this.adShowingSince = Date.now()

    if (this.clickSkipButton()) {
      this.endFastForward()
      return
    }
    // Ad has played a while with no matching skip button — YouTube may have
    // renamed it. Ask the AI to re-find it (once per ad), and keep burning
    // through in the meantime.
    if (Date.now() - this.adShowingSince > HEAL_AFTER_MS) {
      void this.trySelfHeal()
    }
    this.fastForwardAd()
  }

  /**
   * Self-healing: when no known skip-button selector matches during an ad,
   * send the player's control bar to the AI and ask which element is the skip
   * button. If it returns a working, visible selector, cache it and add it to
   * the runtime list so this (and future videos) skip correctly.
   */
  private async trySelfHeal() {
    if (this.healInFlight || !this.player) return
    if (!(await getSettings()).aiEnhancements) return
    this.healInFlight = true // one attempt per ad; reset when the ad ends
    try {
      const controls =
        this.player.querySelector('.ytp-chrome-bottom') ?? this.player
      const html = controls.outerHTML
      const selector = await this.send<string | null>({
        type: 'skipSensei:findSelector',
        html,
        description:
          'the button that skips or dismisses the currently-playing video ad (e.g. a "Skip Ad" / "Skip Ads" button)',
      })
      if (!selector) return
      // Validate: the selector must match a visible, clickable element.
      const el = this.player.querySelector<HTMLElement>(selector)
      if (el && el.offsetParent !== null) {
        log('self-healed skip button selector:', selector)
        if (!this.skipSelectors.includes(selector)) this.skipSelectors.push(selector)
        await addHealedSelector('skipButton', selector)
        this.check() // click it now
      }
    } catch {
      // invalid selector or LLM failure — nothing to do
    }
  }

  private send<T>(message: unknown): Promise<T | null> {
    return chrome.runtime.sendMessage(message).catch(() => null)
  }

  /** Restore normal playback speed + audio once the ad is gone. */
  private endFastForward() {
    if (!this.fastForwarding && !this.mutedForAd) return
    const video = document.querySelector<HTMLVideoElement>(VIDEO)
    if (video) {
      if (video.playbackRate !== 1) video.playbackRate = 1
      if (this.mutedForAd) video.muted = false
    }
    this.mutedForAd = false
    this.fastForwarding = false
  }

  private clickSkipButton(): boolean {
    for (const selector of this.skipSelectors) {
      let button: HTMLElement | null = null
      try {
        button = this.player!.querySelector<HTMLElement>(selector)
      } catch {
        continue // a bad AI-healed selector shouldn't break the loop
      }
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
   * No skip button (yet): burn through the un-skippable portion.
   *
   * Seeking into UN-buffered ad content stalls the player (a multi-second
   * black-frame freeze), and seeking to exact duration parks it in an "ended"
   * state that never loads the main video. So we only ever seek to the end of
   * what's already BUFFERED (instant, no stall) and otherwise rely on a high
   * playback rate + mute to blast through the rest smoothly.
   */
  private fastForwardAd() {
    const video = document.querySelector<HTMLVideoElement>(VIDEO)
    if (!video || !Number.isFinite(video.duration) || video.duration <= 0)
      return

    // Mute so the sped-up ad isn't an audible blip; remember to restore.
    if (!video.muted) {
      this.mutedForAd = true
      video.muted = true
    }
    video.playbackRate = AD_FAST_RATE
    if (video.paused) void video.play().catch(() => {})

    // Jump to the end of the buffered range (leaving a hair so 'ended' fires
    // naturally), but never into unbuffered territory.
    const buffered = video.buffered
    if (buffered.length > 0) {
      const bufferedEnd = buffered.end(buffered.length - 1)
      const target = Math.min(bufferedEnd - 0.1, video.duration - 0.35)
      if (target > video.currentTime + 0.5) video.currentTime = target
    }

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
