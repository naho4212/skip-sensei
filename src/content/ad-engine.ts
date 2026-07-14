import {
  AD_BADGES,
  AD_SHOWING_CLASSES,
  ENFORCEMENT_MESSAGE,
  MODAL_BACKDROP,
  PLAYABILITY_ERROR_SCREEN,
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
  recordActivity,
  setHealedSelectors,
  setYtBackoff,
  updateSettings,
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
 * Circuit breaker for aggressive pruning: one enforcement wall is enough to
 * back off. YouTube can flag the signed-in session on the FIRST wall, so
 * waiting for more just prolongs the exposure — the ABP posture is to detect
 * the wall and stop fighting immediately. Reactive skipping continues.
 */
const WALLS_BEFORE_BREAKER = 1

/**
 * Cloak: opaque cover over the player while an ad is being neutralized, so
 * the user sees a calm "Skipping ad…" panel instead of the 16x flicker,
 * click churn, and pod transitions. Removed the moment the ad is gone.
 */
const CLOAK_ID = 'skip-sensei-ad-cloak'
const CLOAK_STYLE_ID = 'skip-sensei-ad-cloak-style'
/**
 * Branded skip overlay — a faithful port of the Ad Sensei design system's
 * SkipOverlay template (templates/skip-overlay, glyph variant): a dark cover,
 * a slash sweep on mount, the brand ensō that draws in then spins as the
 * loader, the skip glyph popping into its center, "Skipping ad…", and the
 * AD SENSEI brand row. Geometry/timing match skip-spinner.jsx exactly.
 */
const CLOAK_CSS = `
#${CLOAK_ID} {
  position: absolute;
  inset: 0;
  z-index: 9999;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 36px;
  background: #0c0c0c;
  color: #f1f1f1;
  font-family: Roboto, Arial, sans-serif;
  cursor: default;
  overflow: hidden;
}
#${CLOAK_ID} .so-anim { position: relative; width: 96px; height: 96px; }
#${CLOAK_ID} .so-slash {
  position: absolute; left: 50%; top: 50%;
  width: 230.4px; height: 3px; margin-left: -115.2px; margin-top: -1.5px;
  border-radius: 2px; transform-origin: center;
  background: linear-gradient(90deg, transparent, #ffffff 45%, #7c3aed);
  box-shadow: 0 0 14px #7c3aed;
  animation: so-slash 0.7s ease-out 0.05s both;
}
#${CLOAK_ID} .so-enso {
  position: absolute; inset: 0; overflow: visible;
  animation: so-spin 1.5s linear infinite;
  filter: drop-shadow(0 0 12px rgba(124, 58, 237, 0.4));
}
#${CLOAK_ID} .so-enso circle {
  animation: so-draw 0.8s cubic-bezier(0.33, 1, 0.68, 1) both;
}
#${CLOAK_ID} .so-glyph {
  position: absolute; left: 50%; top: 50%;
  transform: translate(-50%, -50%);
}
#${CLOAK_ID} .so-glyph .pop {
  animation: so-pop 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) 0.55s both;
}
#${CLOAK_ID} .so-label {
  font-size: 22px; font-weight: 400; color: #f1f1f1; letter-spacing: 0.2px;
}
#${CLOAK_ID} .so-brand {
  display: flex; gap: 6px; font-size: 11px; font-weight: 700;
  letter-spacing: 0.2em; margin-top: -14px;
}
#${CLOAK_ID} .so-brand .ad { color: #7c3aed; }
#${CLOAK_ID} .so-brand .sensei { color: #6a6a6a; }
@keyframes so-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
@keyframes so-draw { from { stroke-dasharray: 3 100; opacity: 0; } to { stroke-dasharray: 85 100; opacity: 1; } }
@keyframes so-pop { 0% { transform: scale(0); } 70% { transform: scale(1.15); } 100% { transform: scale(1); } }
@keyframes so-slash { 0% { opacity: 0; transform: rotate(122.6deg) scaleX(0.05); } 25% { opacity: 1; } 100% { opacity: 0; transform: rotate(122.6deg) scaleX(1); } }
@media (prefers-reduced-motion: reduce) {
  #${CLOAK_ID} .so-anim, #${CLOAK_ID} .so-anim * { animation: none !important; }
}
`

/**
 * Recovery panel for the final enforcement stage (playability ERROR): the
 * server refuses to send a video stream, so the only fix is clearing
 * youtube.com cookies, which drops the session flag YouTube set.
 */
const HARD_BLOCK_ID = 'skip-sensei-hard-block'
const HARD_BLOCK_STYLE_ID = 'skip-sensei-hard-block-style'
const HARD_BLOCK_CSS = `
#${HARD_BLOCK_ID} {
  position: absolute;
  inset: 0;
  z-index: 10000;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  padding: 24px;
  background: #0c0c0c;
  color: #f1f1f1;
  font-family: Roboto, Arial, sans-serif;
  text-align: center;
  cursor: default;
}
#${HARD_BLOCK_ID} .hb-title { font-size: 20px; font-weight: 500; }
#${HARD_BLOCK_ID} .hb-body {
  max-width: 460px; font-size: 14px; line-height: 1.5; color: #aaaaaa;
}
#${HARD_BLOCK_ID} .hb-clear {
  margin-top: 6px; padding: 10px 20px; border: none; border-radius: 18px;
  background: #7c3aed; color: #ffffff; font: 500 14px Roboto, Arial, sans-serif;
  cursor: pointer;
}
#${HARD_BLOCK_ID} .hb-clear:hover { background: #8b5cf6; }
#${HARD_BLOCK_ID} .hb-clear:disabled { opacity: 0.6; cursor: default; }
#${HARD_BLOCK_ID} .hb-dismiss {
  padding: 6px 12px; border: none; border-radius: 14px;
  background: transparent; color: #6a6a6a;
  font: 400 12px Roboto, Arial, sans-serif; cursor: pointer;
}
#${HARD_BLOCK_ID} .hb-dismiss:hover { color: #aaaaaa; }
#${HARD_BLOCK_ID} .hb-brand {
  display: flex; gap: 6px; font-size: 11px; font-weight: 700;
  letter-spacing: 0.2em; margin-top: 10px;
}
#${HARD_BLOCK_ID} .hb-brand .ad { color: #7c3aed; }
#${HARD_BLOCK_ID} .hb-brand .sensei { color: #6a6a6a; }
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
  /** Cheap class-based ad signal from the previous check, for transition detection. */
  private adClassLast = false
  /** Stuck-ad watchdog: last observed playback position and when it moved. */
  private ffLastTime = -1
  private ffLastAdvanceAt = 0
  private ffLastSeekAt = 0
  private stuckRecoveries = 0
  private cloak: HTMLElement | null = null
  /** Enforcement walls dismissed this session (aggressive-mode circuit breaker). */
  private wallsSeen = 0
  private breakerTripped = false
  /** True once the final "playback blocked" stage was seen on this page. */
  private hardBlockSeen = false
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
    document.getElementById(HARD_BLOCK_ID)?.remove()
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

    // The instant an ad starts, react without waiting out the throttle — this
    // is what removes the visible ad-flash before the cloak/fast-forward kick
    // in. We only bypass on the TRANSITION (cheap class check), so a running
    // ad still throttles and can't cause a mutation storm.
    const now = Date.now()
    const adClassNow = playerShowsAd(this.player)
    const adJustStarted = adClassNow && !this.adClassLast
    this.adClassLast = adClassNow
    if (!adJustStarted && now - this.lastCheckAt < CHECK_THROTTLE_MS) return
    this.lastCheckAt = now

    this.dismissEnforcementWall()
    this.removeOverlayAds()
    this.dismissPauseOverlays()

    const adShowing = this.adIsShowing()
    if (!adShowing) {
      // Ad just ended → record how long it took to clear (read the method
      // BEFORE endFastForward resets the flags). Ignore sub-0.3s flickers.
      if (this.adShowingSince !== null) {
        const seconds = (Date.now() - this.adShowingSince) / 1000
        if (seconds >= 0.3) {
          const method =
            this.skipClickedAt !== null
              ? 'skip button'
              : this.fastForwarding
                ? 'fast-forward'
                : 'skipped'
          this.reportAdTiming(seconds, method)
        }
      }
      this.endFastForward()
      this.removeCloak()
      this.adShowingSince = null
      this.skipClickedAt = null
      this.healInFlight = false
      this.ffLastTime = -1
      this.ffLastSeekAt = 0
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
        this.recordHeal('skipButton', selector)
        this.check() // click it now
      }
    } catch {
      // invalid selector or LLM failure — nothing to do
    }
  }

  /**
   * Record a CONFIRMED self-heal — one that passed content-side validation
   * and is now cached and in use. Both the user-facing activity log and the
   * improvement telemetry fire from here (not when the AI merely answers), so
   * neither ever shows a selector we rejected.
   */
  private recordHeal(target: 'skipButton' | 'enforcementWall', selector: string) {
    const label =
      target === 'skipButton'
        ? `self-healed the skip button → ${selector}`
        : `self-healed the ad-blocker wall → ${selector}`
    void recordActivity('AI enhancements', label, 'youtube.com')
    void this.send({
      type: 'skipSensei:event',
      kind: 'self_heal',
      fields: { target, selector },
    })
  }

  /**
   * How long an ad took to clear, for testing/monitoring. Logged to the
   * activity page (visible locally) and sent as an anonymous 'ad_skip_timing'
   * diagnostics event (aggregatable), gated on the telemetry setting.
   */
  private reportAdTiming(seconds: number, method: string) {
    const secs = seconds.toFixed(1)
    void recordActivity(
      'Skip YouTube ads',
      `skipped an ad in ${secs}s (${method})`,
      'youtube.com',
    )
    void this.send({
      type: 'skipSensei:event',
      kind: 'ad_skip_timing',
      fields: { seconds: secs, method },
    })
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
    // Structure/geometry ported verbatim from skip-spinner.jsx (glyph variant):
    // slash sweep, spinning ensō (r42, pathLength 100, dasharray 85 100,
    // rotate 18), and the two-triangle+bar skip glyph popping in the center.
    cloak.innerHTML = `
      <div class="so-anim" aria-hidden="true">
        <div class="so-slash"></div>
        <svg class="so-enso" width="96" height="96" viewBox="0 0 100 100">
          <circle cx="50" cy="50" r="42" fill="none" stroke="#7c3aed"
            stroke-width="6.2" stroke-linecap="round" pathLength="100"
            stroke-dasharray="85 100" transform="rotate(18 50 50)" />
        </svg>
        <div class="so-glyph"><div class="pop">
          <svg width="38.4" height="23.04" viewBox="0 0 100 60">
            <polygon points="0,0 34,30 0,60" fill="#7c3aed" />
            <polygon points="38,0 72,30 38,60" fill="#7c3aed" />
            <rect x="80" y="0" width="12" height="60" rx="5" fill="#7c3aed" />
          </svg>
        </div></div>
      </div>
      <div class="so-label">Skipping ad&hellip;</div>
      <div class="so-brand"><span class="ad">AD</span><span class="sensei">SENSEI</span></div>
    `
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
   * No skip button (yet): burn through the un-skippable portion by seeking
   * STRAIGHT TO THE END of the ad. Loading just the final segment takes ~1s
   * regardless of ad length, whereas fast-forwarding the whole ad at 16x is
   * bounded by how fast the ad downloads (a 30s ad can take many seconds).
   * We leave a hair before the exact end so 'ended' fires naturally (seeking
   * to exactly duration parks the player in an 'ended' state that never
   * transitions to the main video). A high playback rate + mute is the
   * fallback while the end segment loads, or if YouTube resets the seek.
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
    if (video.seeking) {
      // A seek to the end of an unbuffered ad legitimately freezes
      // currentTime while the segment loads — that's progress, not a wedge.
      this.ffLastAdvanceAt = now
    } else if (video.currentTime !== this.ffLastTime) {
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

    // Jump straight to the end of the ad — loading only the final segment,
    // not the whole ad. Retry at most every 1.5s (not while a seek is in
    // flight): if YouTube resets the seek on a non-seekable ad, this stops it
    // fighting itself, and the 16x rate above still burns through in between.
    const target = video.duration - 0.4
    if (
      !video.seeking &&
      target > video.currentTime + 1 &&
      now - this.ffLastSeekAt > 1500
    ) {
      this.ffLastSeekAt = now
      video.currentTime = target
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

    // Final enforcement stage: the server answered the watch request with a
    // playability ERROR — the enforcement message renders inside the player's
    // #error-screen instead of a dismissible dialog, and no video stream
    // exists. Removing the message here just leaves a dead black player (and
    // is how earlier builds "handled" it). Leave the DOM alone and offer the
    // real remedy in place: clearing youtube.com cookies lifts the flag.
    if (message.closest(PLAYABILITY_ERROR_SCREEN)) {
      this.handleHardBlock()
      return
    }

    this.wallsSeen++
    void this.maybeTripAggressiveBreaker()

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
   * Final enforcement stage: playback is refused server-side, so back off
   * (same breaker as the modal wall), flag the popup notice, and offer the
   * one real fix — clearing youtube.com cookies — right on the dead player.
   */
  private handleHardBlock() {
    if (!this.hardBlockSeen) {
      this.hardBlockSeen = true
      this.wallsSeen++
      void this.maybeTripAggressiveBreaker()
      // The breaker only records the backoff when it flips the aggressive
      // setting; the popup notice must show even when it was already off.
      void setYtBackoff(this.wallsSeen)
      void recordActivity(
        'Skip YouTube ads',
        'YouTube blocked playback for this session — offered the cookie-clear fix',
        'youtube.com',
      )
      void this.send({
        type: 'skipSensei:event',
        kind: 'yt_hard_block',
        fields: { walls: String(this.wallsSeen) },
      })
      log('YouTube hard playback block detected — showing recovery panel')
    }
    this.showHardBlockPanel()
  }

  private showHardBlockPanel() {
    if (document.getElementById(HARD_BLOCK_ID)) return
    const host =
      this.player ?? document.querySelector<HTMLElement>(PLAYER)
    if (!host) return

    if (!document.getElementById(HARD_BLOCK_STYLE_ID)) {
      const style = document.createElement('style')
      style.id = HARD_BLOCK_STYLE_ID
      style.textContent = HARD_BLOCK_CSS
      document.head.appendChild(style)
    }

    const panel = document.createElement('div')
    panel.id = HARD_BLOCK_ID

    const title = document.createElement('div')
    title.className = 'hb-title'
    title.textContent = 'YouTube has blocked playback for this session'

    const body = document.createElement('div')
    body.className = 'hb-body'
    body.textContent =
      'YouTube flagged this browser session for ad blocking, so it refuses to ' +
      'play videos — reloading won’t help. Clearing YouTube’s cookies lifts ' +
      'the flag. You’ll be signed out of YouTube and may need to sign back in.'

    const clear = document.createElement('button')
    clear.className = 'hb-clear'
    clear.textContent = 'Clear YouTube cookies & reload'
    clear.addEventListener('click', () => {
      clear.disabled = true
      clear.textContent = 'Clearing…'
      void this.send<{ ok: boolean } | null>({
        type: 'skipSensei:clearYtCookies',
      }).then((res) => {
        // On success the service worker reloads this tab; only a failure
        // needs handling here.
        if (!res?.ok) {
          clear.disabled = false
          clear.textContent = 'Clear YouTube cookies & reload'
          body.textContent =
            'Clearing failed — you can clear cookies for youtube.com from ' +
            'the browser’s site settings instead, then reload.'
        }
      })
    })

    const dismiss = document.createElement('button')
    dismiss.className = 'hb-dismiss'
    dismiss.textContent = "Dismiss and show YouTube's message"
    dismiss.addEventListener('click', () => panel.remove())

    const brand = document.createElement('div')
    brand.className = 'hb-brand'
    const ad = document.createElement('span')
    ad.className = 'ad'
    ad.textContent = 'AD'
    const sensei = document.createElement('span')
    sensei.className = 'sensei'
    sensei.textContent = 'SENSEI'
    brand.append(ad, sensei)

    panel.append(title, body, clear, dismiss, brand)
    host.appendChild(panel)
  }

  /**
   * Aggressive-pruning circuit breaker: repeated enforcement walls mean
   * YouTube has likely detected the response pruning. Auto-disable it —
   * reactive skipping (this engine) keeps working — and say so in the
   * activity log so the user knows why ads are visible-then-skipped again.
   */
  private async maybeTripAggressiveBreaker() {
    if (this.breakerTripped || this.wallsSeen < WALLS_BEFORE_BREAKER) return
    this.breakerTripped = true
    try {
      // The wall means YouTube detected the pruning and may have flagged the
      // session. Back off: turn aggressive mode off (reactive skipping stays
      // on) and drop a flag so the popup can tell the user how to clear the
      // flag YouTube set (the setting toggling alone won't lift it).
      if (!(await getSettings()).aggressivePruning) return
      await updateSettings({ aggressivePruning: false })
      await setYtBackoff(this.wallsSeen)
      await recordActivity(
        'Aggressive ad blocking',
        'YouTube flagged the session — aggressive mode auto-disabled (reactive skipping still on)',
        'youtube.com',
      )
      // Detection signal: how often aggressive pruning gets caught in the
      // wild tells us whether it's worth keeping / how to harden it.
      void this.send({
        type: 'skipSensei:event',
        kind: 'aggressive_breaker',
        fields: { walls: String(this.wallsSeen) },
      })
      log('aggressive pruning auto-disabled — YouTube enforcement wall')
    } catch {
      // storage failure — leave the setting as-is
    }
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
        this.recordHeal('enforcementWall', selector)
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
