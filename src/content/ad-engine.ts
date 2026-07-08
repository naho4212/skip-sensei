import {
  AD_BADGES,
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
import {
  addHealedSelector,
  getHealedSelectors,
  getSettings,
  setHealedSelectors,
} from '../storage'
import type { AdSkipMethod } from '../types'

/**
 * Guard against over-generic AI-healed selectors: the LLM once answered with
 * literally `button`, which matches ANY player button — every video then
 * looked like an ad forever (permanent cloak, rogue clicks). A healed
 * selector must carry at least one class/id/attribute constraint.
 */
function isSaneHealedSelector(selector: string): boolean {
  return /[.#[]/.test(selector) && !/^[a-z*\s>+~]+$/i.test(selector)
}

/** And whatever a healed selector matches must actually read as a skip control. */
function looksLikeSkipControl(el: HTMLElement): boolean {
  const text = `${el.textContent ?? ''} ${el.getAttribute('aria-label') ?? ''}`
  return /skip/i.test(text)
}

/** Playback rate for burning through un-skippable ads. */
const AD_FAST_RATE = 16

/**
 * Class/badge-level "an ad is on screen" check, usable outside the engine —
 * the sponsor engine must NOT sample video.duration while a pre-roll plays
 * (the ad shares the <video> element, so the duration is the ad's).
 */
export function playerShowsAd(
  player: HTMLElement | null = document.querySelector<HTMLElement>(PLAYER),
): boolean {
  if (!player) return false
  if (AD_SHOWING_CLASSES.some((cls) => player.classList.contains(cls))) {
    return true
  }
  return AD_BADGES.some((sel) => player.querySelector(sel))
}

/** How long an ad may play with no matching skip button before we try to self-heal. */
const HEAL_AFTER_MS = 7000

/**
 * How long after clicking a skip button we wait for the ad to actually end
 * before concluding the click was ignored (YouTube's newer skip button
 * intermittently drops synthetic clicks) and burning through instead.
 */
const SKIP_CLICK_GRACE_MS = 1500

/**
 * Floor between check() runs. The MutationObserver fires for every player
 * DOM mutation, and check() itself mutates (event dispatch, seeks) — without
 * a floor that feeds back into a mutation storm that pegs the main thread.
 * The 1s fallback interval still guarantees forward progress.
 */
const CHECK_THROTTLE_MS = 250

/** Floor between synthetic click sequences on the same lingering button. */
const CLICK_RETRY_MS = 500

/** Ad playback frozen this long → try to unwedge the player. */
const STUCK_AFTER_MS = 3000
const MAX_STUCK_RECOVERIES = 3

/**
 * Cloak: opaque cover over the player while an ad is being neutralized, so
 * the user sees a calm "Skipping ad…" panel instead of the 16x flicker,
 * click churn, and pod transitions. Removed the moment the ad is gone.
 */
const CLOAK_ID = 'skip-sensei-ad-cloak'
const CLOAK_STYLE_ID = 'skip-sensei-ad-cloak-style'
const CLOAK_CSS = `
#${CLOAK_ID} {
  position: absolute;
  inset: 0;
  z-index: 9999;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  background: #0f0f0f;
  color: rgba(255, 255, 255, 0.85);
  font: 500 14px/1.4 "Roboto", "Arial", sans-serif;
  cursor: default;
}
#${CLOAK_ID} .skip-sensei-cloak-spinner {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 2px solid rgba(255, 255, 255, 0.25);
  border-top-color: #fff;
  animation: skip-sensei-cloak-spin 0.8s linear infinite;
}
@keyframes skip-sensei-cloak-spin {
  to { transform: rotate(360deg); }
}
`

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
  /**
   * When we first clicked the current ad's skip button. Clicking can silently
   * fail, so this also gates the fallback: an ad that outlives the click by
   * more than the grace period gets fast-forwarded instead. Reset whenever the
   * button disappears or the ad ends, so each ad in a pod gets its own click
   * (and its own skip count).
   */
  private skipClickedAt: number | null = null
  private lastCheckAt = 0
  private lastClickDispatchAt = 0
  /** Stuck-ad watchdog: last observed playback position and when it moved. */
  private ffLastTime = -1
  private ffLastAdvanceAt = 0
  private stuckRecoveries = 0
  private cloak: HTMLElement | null = null
  /** AI-healed skip-button selectors (kept apart from the trusted hardcoded
   * list: healed matches must additionally pass looksLikeSkipControl). */
  private healedSkipSelectors: string[] = []
  /** AI-healed selectors for the anti-adblock enforcement modal. */
  private wallSelectors: string[] = []
  private wallHealInFlight = false
  /** Wall-clock when the current ad started showing (for the heal timer). */
  private adShowingSince: number | null = null
  private healInFlight = false

  constructor(private onSkip: (method: AdSkipMethod) => void) {}

  start() {
    void this.loadHealedSelectors()
    this.attachWhenPlayerExists()
  }

  /** Seed the runtime selector lists with any selectors the AI healed earlier,
   * dropping (and purging from storage) any that fail the sanity check. */
  private async loadHealedSelectors() {
    const healed = await getHealedSelectors()
    const storedSkip = healed.skipButton ?? []
    this.healedSkipSelectors = storedSkip.filter(isSaneHealedSelector)
    if (this.healedSkipSelectors.length !== storedSkip.length) {
      log('purged unsafe healed skip selectors:', storedSkip)
      void setHealedSelectors('skipButton', this.healedSkipSelectors)
    }
    const storedWall = healed.enforcementWall ?? []
    this.wallSelectors = storedWall.filter(isSaneHealedSelector)
    if (this.wallSelectors.length !== storedWall.length) {
      void setHealedSelectors('enforcementWall', this.wallSelectors)
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
    this.skipClickedAt = null
    // Teardown must leave the video watchable (orphaned scripts included):
    // uncover the player and restore speed/audio.
    this.removeCloak()
    const video = document.querySelector<HTMLVideoElement>(VIDEO)
    if (video) {
      if (video.playbackRate !== 1) video.playbackRate = 1
      if (this.mutedForAd) video.muted = false
    }
    this.mutedForAd = false
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
    // Extension reloaded/removed → this copy of the script is orphaned and
    // every chrome.* call throws "Extension context invalidated". Park
    // quietly; the tab's next refresh runs the fresh script.
    if (!chrome.runtime?.id) {
      this.stop()
      return
    }
    if (!this.player) return

    const now = Date.now()
    if (now - this.lastCheckAt < CHECK_THROTTLE_MS) return
    this.lastCheckAt = now

    this.dismissEnforcementWall()
    this.removeOverlayAds()
    this.dismissPauseOverlays()

    const adShowing = this.adIsShowing()
    if (!adShowing) {
      this.endFastForward()
      this.removeCloak()
      this.adShowingSince = null
      this.skipClickedAt = null
      this.healInFlight = false
      this.ffLastTime = -1
      this.stuckRecoveries = 0
      return
    }

    if (this.adShowingSince === null) this.adShowingSince = Date.now()
    this.applyCloak()

    if (this.clickSkipButton()) {
      // Give the click a moment to take effect — but no longer. YouTube's
      // skip button sometimes ignores synthetic clicks; an ad that survives
      // the click (the 2nd ad of a pod, typically) must not park here at
      // normal speed, so past the grace period we fall through and burn it.
      if (Date.now() - this.skipClickedAt! <= SKIP_CLICK_GRACE_MS) {
        // Rate back to normal for the transition, but STAY muted/cloaked —
        // the ad is still on screen until the click lands.
        const video = document.querySelector<HTMLVideoElement>(VIDEO)
        if (video && video.playbackRate !== 1) video.playbackRate = 1
        return
      }
    } else {
      this.skipClickedAt = null
    }
    // Ad has played a while with no working skip button — YouTube may have
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
      if (!selector || !isSaneHealedSelector(selector)) return
      // Validate: must match a visible element that actually reads as a
      // skip control. (The LLM once returned bare `button` — caching that
      // made every video register as an ad.)
      const el = this.player.querySelector<HTMLElement>(selector)
      if (el && el.offsetParent !== null && looksLikeSkipControl(el)) {
        log('self-healed skip button selector:', selector)
        if (!this.healedSkipSelectors.includes(selector))
          this.healedSkipSelectors.push(selector)
        await addHealedSelector('skipButton', selector)
        this.check() // click it now
      }
    } catch {
      // invalid selector or LLM failure — nothing to do
    }
  }

  private send<T>(message: unknown): Promise<T | null> {
    // sendMessage throws SYNCHRONOUSLY when the extension context is
    // invalidated — .catch() alone never sees it.
    try {
      return chrome.runtime.sendMessage(message).catch(() => null)
    } catch {
      return Promise.resolve(null)
    }
  }

  /**
   * Cover the player and mute the moment an ad is detected. Everything the
   * engine does next (skip clicks, 16x burn, pod transitions, stuck
   * recovery) happens behind the cover. The cloak sits above the ad's UI
   * but querySelector/synthetic clicks still reach the skip button fine.
   */
  private applyCloak() {
    const video = document.querySelector<HTMLVideoElement>(VIDEO)
    if (video && !video.muted) {
      this.mutedForAd = true
      video.muted = true
    }
    if (this.cloak?.isConnected) return
    if (!document.getElementById(CLOAK_STYLE_ID)) {
      const style = document.createElement('style')
      style.id = CLOAK_STYLE_ID
      style.textContent = CLOAK_CSS
      document.head.appendChild(style)
    }
    const cloak = document.createElement('div')
    cloak.id = CLOAK_ID
    const spinner = document.createElement('div')
    spinner.className = 'skip-sensei-cloak-spinner'
    const label = document.createElement('span')
    label.textContent = 'Skipping ad…'
    cloak.append(spinner, label)
    this.player?.appendChild(cloak)
    this.cloak = cloak
  }

  private removeCloak() {
    document.getElementById(CLOAK_ID)?.remove()
    this.cloak = null
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

  /**
   * Detect ad playback from several independent signals — YouTube renames any
   * one of them regularly (player class, badge class, button class), and the
   * class-only check going stale means NOTHING fires (no skip, no
   * fast-forward). Any single signal is enough.
   */
  private adIsShowing(): boolean {
    if (playerShowsAd(this.player)) return true
    return this.findSkipButton() !== null
  }

  private findSkipButton(): HTMLElement | null {
    for (const selector of SKIP_BUTTONS) {
      const button = this.player!.querySelector<HTMLElement>(selector)
      if (button && button.offsetParent !== null) return button
    }
    for (const selector of this.healedSkipSelectors) {
      let button: HTMLElement | null = null
      try {
        button = this.player!.querySelector<HTMLElement>(selector)
      } catch {
        continue // a bad AI-healed selector shouldn't break the loop
      }
      // Healed matches are only trusted if the element reads as a skip
      // control — a generic selector must never turn "ad showing" on.
      if (button && button.offsetParent !== null && looksLikeSkipControl(button))
        return button
    }
    // Last resort, survives class renames: any visible player button whose
    // label is exactly "Skip" / "Skip Ad(s)". Kept strict so nothing else
    // (e.g. "Skip navigation") can ever match.
    for (const button of this.player!.querySelectorAll<HTMLElement>(
      'button',
    )) {
      if (button.offsetParent === null) continue
      const text = (button.textContent ?? '').trim()
      const aria = button.getAttribute('aria-label') ?? ''
      if (/^skip( ads?)?$/i.test(text) || /\bskip ads?\b/i.test(aria)) {
        return button
      }
    }
    return null
  }

  private clickSkipButton(): boolean {
    const button = this.findSkipButton()
    if (!button) return false
    // Rate-limit the event bursts: a button that lingers (ignored click)
    // would otherwise be re-clicked on every mutation-driven check.
    const now = Date.now()
    if (now - this.lastClickDispatchAt >= CLICK_RETRY_MS) {
      this.lastClickDispatchAt = now
      this.dispatchRealisticClick(button)
    }
    if (this.skipClickedAt === null) {
      this.skipClickedAt = now
      this.onSkip('skip-button')
    }
    return true
  }

  /**
   * A bare .click() is not always enough: YouTube's newer skip button listens
   * for pointer/mouse events and can ignore the synthetic click alone. Send
   * the full sequence a real tap produces, aimed at the button's center.
   */
  private dispatchRealisticClick(el: HTMLElement) {
    const rect = el.getBoundingClientRect()
    const opts = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    }
    el.dispatchEvent(
      new PointerEvent('pointerdown', { ...opts, pointerId: 1, isPrimary: true }),
    )
    el.dispatchEvent(new MouseEvent('mousedown', opts))
    el.dispatchEvent(
      new PointerEvent('pointerup', { ...opts, pointerId: 1, isPrimary: true }),
    )
    el.dispatchEvent(new MouseEvent('mouseup', opts))
    el.click()
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

    // Stuck-ad watchdog. Two known wedge states: the ad reaches 'ended' but
    // YouTube never transitions away (parked), or a seek stalls playback
    // indefinitely. Either way currentTime stops moving while the ad UI
    // stays up — rewind a hair at normal speed so YouTube's own
    // end-of-ad transition can fire, instead of pushing harder.
    const now = Date.now()
    if (video.currentTime !== this.ffLastTime) {
      this.ffLastTime = video.currentTime
      this.ffLastAdvanceAt = now
    } else if (
      now - this.ffLastAdvanceAt > STUCK_AFTER_MS &&
      this.stuckRecoveries < MAX_STUCK_RECOVERIES
    ) {
      this.stuckRecoveries++
      this.ffLastAdvanceAt = now
      log('ad player looks stuck; recovery attempt', this.stuckRecoveries)
      video.playbackRate = 1
      video.currentTime = Math.max(0, video.duration - 1)
      void video.play().catch(() => {})
      this.onSkip('stuck-recovery')
      return
    }

    // Mute so the sped-up ad isn't an audible blip; remember to restore.
    if (!video.muted) {
      this.mutedForAd = true
      video.muted = true
    }
    video.playbackRate = AD_FAST_RATE
    // Never play() an 'ended' video: that restarts it from 0 and loops the
    // ad forever. Ended-but-parked is the watchdog's job above.
    if (video.paused && !video.ended) void video.play().catch(() => {})

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
    // Known selector, plus any the AI healed after a prior YouTube change.
    let message = document.querySelector(ENFORCEMENT_MESSAGE)
    if (!message) {
      for (const selector of this.wallSelectors) {
        try {
          message = document.querySelector(selector)
        } catch {
          continue
        }
        if (message) break
      }
    }

    if (!message) {
      // Wall may be present under a renamed element — self-heal if it looks blocked.
      void this.trySelfHealWall()
      return
    }

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

  /**
   * Self-heal the enforcement wall: if the video is unexpectedly paused with a
   * large blocking dialog present that our known selectors didn't match,
   * YouTube likely renamed the wall. Ask the AI which element is the
   * ad-blocker enforcement modal, cache it, and dismiss.
   */
  private async trySelfHealWall() {
    if (this.wallHealInFlight) return
    const video = document.querySelector<HTMLVideoElement>(VIDEO)
    const dialog = document.querySelector('ytd-popup-container tp-yt-paper-dialog, tp-yt-paper-dialog')
    // Only bother when the state actually looks like a block: paused + a dialog.
    if (!video || !video.paused || !dialog) return
    if (!(await getSettings()).aiEnhancements) return

    this.wallHealInFlight = true
    try {
      const selector = await this.send<string | null>({
        type: 'skipSensei:findSelector',
        html: (dialog as HTMLElement).outerHTML.slice(0, 6000),
        description:
          'the YouTube ad-blocker enforcement message that says video playback will be blocked (the modal to remove), if present',
      })
      if (!selector || !isSaneHealedSelector(selector)) return
      let el: Element | null = null
      try {
        el = document.querySelector(selector)
      } catch {
        return
      }
      if (el) {
        log('self-healed enforcement wall selector:', selector)
        if (!this.wallSelectors.includes(selector)) this.wallSelectors.push(selector)
        await addHealedSelector('enforcementWall', selector)
        this.dismissEnforcementWall() // dismiss it now via the healed selector
      }
    } catch {
      // nothing to do
    } finally {
      // Allow another attempt if the wall reappears later.
      setTimeout(() => (this.wallHealInFlight = false), 5000)
    }
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
