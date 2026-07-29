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
  setHealedSelectors,
} from '../storage'
import type { AdSkipMethod } from '../types'
import { MIN_RESUME_SECONDS } from '../resume'

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

/** Seconds → m:ss (h:mm:ss past an hour), for the recovery panel's copy. */
function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const s = String(total % 60).padStart(2, '0')
  const m = Math.floor(total / 60) % 60
  const h = Math.floor(total / 3600)
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
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
 * Floor between check() runs. The MutationObserver fires for every player
 * DOM mutation, and check() itself mutates (event dispatch, seeks) — without
 * a floor that feeds back into a mutation storm that pegs the main thread.
 * The fallback interval below still guarantees forward progress.
 */
const CHECK_THROTTLE_MS = 250

/**
 * Safety-net poll when the player stops mutating mid-ad (no observer events to
 * ride). Drives the seek-retry and end-of-ad transition, so it caps how long an
 * ad can linger after YouTube goes quiet. Kept well above CHECK_THROTTLE_MS so
 * the throttle, not this, governs steady-state cost.
 */
const FALLBACK_INTERVAL_MS = 400

/**
 * Floor between seek-to-end retries. A skippable ad is often non-seekable for
 * its first few seconds (YouTube resets the seek); retrying this often re-tries
 * the moment it becomes seekable, sometimes ending it before the ~5s Skip
 * button even appears. Too low just fights a non-seekable ad and wastes cycles.
 */
const SEEK_RETRY_MS = 700

/** Floor between synthetic click sequences on the same lingering button. */
const CLICK_RETRY_MS = 500

/** Ad playback frozen this long → try to unwedge the player. */
const STUCK_AFTER_MS = 3000
const MAX_STUCK_RECOVERIES = 3

/**
 * Cloak: opaque cover over the player while an ad is being neutralized, so
 * the user sees a calm "Skipping ad…" panel instead of the 16x flicker,
 * click churn, and pod transitions. Removed the moment the ad is gone.
 *
 * Re-enabled (Jul 14) now that the skip-latency work has shipped and been
 * verified — the user sees the branded panel instead of the raw engine
 * churn. Flip OFF while tuning skip behavior, when the ad must stay visible;
 * everything else (mute, skip, cleanup) is unchanged either way, and
 * removeCloak() still runs so stale covers get cleared.
 */
const CLOAK_ENABLED = true
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
  /* Only matters on the fallback host (#movie_player), which YouTube sets to
   * visibility:hidden during the enforcement error — visibility inherits, but
   * a descendant can override an ancestor's hidden with visibility:visible. */
  visibility: visible !important;
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
/* The escape hatch that always works, but costs the sign-in: outlined so it
 * reads as a real choice next to the primary action, not as fine print like
 * the dismiss link below it. */
#${HARD_BLOCK_ID} .hb-secondary {
  padding: 9px 18px; border: 1px solid #3f3f3f; border-radius: 18px;
  background: transparent; color: #d0d0d0;
  font: 400 13px Roboto, Arial, sans-serif; cursor: pointer;
}
#${HARD_BLOCK_ID} .hb-secondary:hover { border-color: #6a6a6a; color: #ffffff; }
#${HARD_BLOCK_ID} .hb-secondary:disabled { opacity: 0.6; cursor: default; }
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
   * When we first clicked the current ad's skip button. Attribution only
   * (timing method + skip-count dedup): the click and the seek-to-end fallback
   * now fire in the same tick, so nothing waits on this. Reset whenever the
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
  /** One skip-failure report per ad break, not one per tick. */
  private failureReported = false
  private cloak: HTMLElement | null = null
  /** Enforcement walls dismissed this session (aggressive-mode circuit breaker). */
  private wallsSeen = 0
  /** True once the final "playback blocked" stage was seen on this page. */
  private hardBlockSeen = false
  /** True after the user dismisses the recovery panel — check() runs every
   * second and would otherwise rebuild it immediately. */
  private hardBlockPanelDismissed = false
  /** AI-healed skip-button selectors (kept apart from the trusted hardcoded
   * list: healed matches must additionally pass looksLikeSkipControl). */
  private healedSkipSelectors: string[] = []
  /** AI-healed selectors for the anti-adblock enforcement modal. */
  private wallSelectors: string[] = []
  private wallHealInFlight = false
  /** Last observed position of the CONTENT video (sampled only while no ad is
   * showing — during an ad the <video> reports the ad's own timeline). Carried
   * across the cookie-clear reload so the user doesn't lose their place. */
  private lastContentTime = 0
  /** Wall-clock when the current ad started showing (for the heal timer). */
  private adShowingSince: number | null = null
  private healInFlight = false
  /** Actions taken during the current ad break (a pod of consecutive ads
   * shares one ad-showing state), reported as ONE entry when it clears. */
  private breakMethods: AdSkipMethod[] = []
  /** Ad footage neutralized this break: completed pod ads + the current one
   * (the <video> duration is the ad's while ad-showing). */
  private breakAdSeconds = 0
  private curAdDuration = 0

  constructor(
    private onSkip: (
      method: AdSkipMethod,
      count?: number,
      quiet?: boolean,
    ) => void,
  ) {}

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

  /** The player renders asynchronously after SPA navigation; poll until it
   * exists. 80 × 250ms: the script now starts at document_start, when the DOM
   * is empty, so the poll must cover the whole slow-connection render window
   * (yt-navigate-finish re-kicks the engine if it still expires). */
  private attachWhenPlayerExists(attempt = 0) {
    const player = document.querySelector<HTMLElement>(PLAYER)
    if (!player) {
      if (attempt < 80) {
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
    this.fallbackTimer = window.setInterval(
      () => this.check(),
      FALLBACK_INTERVAL_MS,
    )
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
      this.sampleContentTime()
      // Ad break just ended → report it as ONE aggregated entry (read the
      // tallies BEFORE endFastForward resets the flags). Ignore sub-0.3s
      // flickers.
      if (this.adShowingSince !== null) {
        const seconds = (Date.now() - this.adShowingSince) / 1000
        if (seconds >= 0.3) this.reportBreakCleared(seconds)
      }
      this.endFastForward()
      this.removeCloak()
      this.adShowingSince = null
      this.skipClickedAt = null
      this.healInFlight = false
      this.ffLastTime = -1
      this.ffLastSeekAt = 0
      this.stuckRecoveries = 0
      this.failureReported = false
      this.breakMethods = []
      this.breakAdSeconds = 0
      this.curAdDuration = 0
      return
    }

    if (this.adShowingSince === null) this.adShowingSince = Date.now()
    this.applyCloak()

    // Click the skip button AND seek-to-end in the same tick. YouTube's skip
    // button intermittently ignores synthetic clicks, and the old "wait a
    // grace period before burning through" fallback cost 1.5s per failed
    // click — across an ad pod plus the seek-retry floor that compounded into
    // multi-second skips. The seek is harmless when the click lands: the ad
    // video is discarded either way.
    if (!this.clickSkipButton()) {
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
   * Remember where the content video is, so the cookie-clear reload can come
   * back to it. Only called with no ad showing; a hard block also freezes the
   * video at 0, so keep the last non-zero reading rather than overwriting it.
   */
  private sampleContentTime() {
    const video = document.querySelector<HTMLVideoElement>(VIDEO)
    const t = video?.currentTime ?? 0
    if (Number.isFinite(t) && t > 0) this.lastContentTime = t
  }

  /** Where playback had reached before the wall, for the resume-after-reload
   * path (0 when nothing worth restoring was seen). */
  resumeSeconds(): number {
    return this.lastContentTime
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
    // Via the SW: activity writes from N tabs raced the shared log directly.
    void this.send({
      type: 'skipSensei:logActivity',
      feature: 'AI enhancements',
      action: label,
    })
    void this.send({
      type: 'skipSensei:event',
      kind: 'self_heal',
      fields: { target, selector },
    })
  }

  /** In-break actions are tallied and reported once when the break clears
   * (see reportBreakCleared) instead of producing a log line each. */
  private tallySkip(method: AdSkipMethod) {
    this.breakMethods.push(method)
  }

  /** Track how much ad footage this break holds: while ad-showing, the
   * <video> duration is the current ad's; a >1s change means the pod moved
   * to its next ad, so bank the finished one. Bounds guard against sampling
   * the main video during the ad→content swap. */
  private noteAdDuration(duration: number) {
    if (!Number.isFinite(duration) || duration < 0.5 || duration > 600) return
    if (this.curAdDuration !== 0 && Math.abs(duration - this.curAdDuration) > 1)
      this.breakAdSeconds += this.curAdDuration
    this.curAdDuration = duration
  }

  /**
   * ONE activity line, ONE counter bump, and ONE timing event per ad break.
   * A pod of consecutive ads shares a single ad-showing state, so reporting
   * each action as it happened (plus a separate timing line whose method was
   * just the LAST action) rendered one break as three log rows with a
   * duration that looked wrong next to them. Logged to the activity page
   * (visible locally) and sent as an anonymous 'ad_skip_timing' diagnostics
   * event (aggregatable), gated on the telemetry setting.
   */
  private reportBreakCleared(seconds: number) {
    const secs = seconds.toFixed(1)
    const ads = this.breakMethods.length
    const clicks = this.breakMethods.filter((m) => m === 'skip-button').length
    const ffs = this.breakMethods.filter((m) => m === 'fast-forward').length
    const recoveries = ads - clicks - ffs
    const adFootage = Math.round(this.breakAdSeconds + this.curAdDuration)
    const footage = adFootage > 0 ? `${adFootage}s of ads` : null
    const label =
      clicks > 0
        ? 'skip button'
        : ffs > 0
          ? 'fast-forward'
          : recoveries > 0
            ? 'stuck recovery'
            : 'skipped'
    let desc: string
    if (ads === 0) {
      // Cleared without an engine action (e.g. a short bumper ran out).
      desc = `an ad ended on its own after ${secs}s`
    } else if (ads === 1) {
      desc = footage
        ? `skipped ${footage} in ${secs}s (${label})`
        : `skipped an ad in ${secs}s (${label})`
    } else {
      const parts = [
        clicks > 0 ? `${clicks} skip button` : '',
        ffs > 0 ? `${ffs} fast-forwarded` : '',
        recoveries > 0 ? `${recoveries} stuck recovery` : '',
      ].filter(Boolean)
      desc = `skipped ${ads} ads${footage ? ` (${footage})` : ''} in ${secs}s (${parts.join(', ')})`
    }
    void this.send({
      type: 'skipSensei:logActivity',
      feature: 'Skip YouTube ads',
      action: desc,
    })
    if (ads > 0) {
      const primary: AdSkipMethod =
        clicks > 0 ? 'skip-button' : ffs > 0 ? 'fast-forward' : 'stuck-recovery'
      // quiet: the aggregated line above IS the activity entry; the message
      // only carries the per-ad counter bump.
      this.onSkip(primary, ads, true)
    }
    // Structured copy of the same numbers the activity line describes in prose,
    // so Options can actually aggregate them (median / p90 / worst). Routed
    // through the SW: two watch tabs writing the timings list directly would
    // race it — each tab's storage module has its own serialization chain.
    if (ads > 0) {
      void this.send({
        type: 'skipSensei:skipTiming',
        s: Number(secs),
        m: label,
        ads,
      })
    }
    void this.send({
      type: 'skipSensei:event',
      kind: 'ad_skip_timing',
      fields: {
        seconds: secs,
        method: label,
        ads: String(ads),
        adSeconds: String(adFootage),
      },
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
    if (!CLOAK_ENABLED) return
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
      this.tallySkip('skip-button')
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
    this.noteAdDuration(video.duration)

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
      // Last recovery attempt exhausted: from here the ad plays through and
      // the user watches it. That's the engine LOSING, and nothing used to
      // record it — every existing signal only fires on a successful skip.
      if (this.stuckRecoveries === MAX_STUCK_RECOVERIES && !this.failureReported) {
        this.failureReported = true
        void this.send({
          type: 'skipSensei:event',
          kind: 'skip_failed',
          fields: {
            reason: 'stuck',
            adSeconds: String(Math.round(video.duration || 0)),
          },
        })
      }
      log('ad player looks stuck; recovery attempt', this.stuckRecoveries)
      video.playbackRate = 1
      video.currentTime = Math.max(0, video.duration - 1)
      void video.play().catch(() => {})
      this.tallySkip('stuck-recovery')
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
    // not the whole ad. Retry at most every SEEK_RETRY_MS (not while a seek is
    // in flight): if YouTube resets the seek on a non-seekable ad, this stops
    // it fighting itself, and the 16x rate above still burns through in between.
    // After a click, only seek while the ad-showing class is still up: in the
    // click→content transition the skip button can linger after the ad class
    // drops, and a seek landing on the freshly-swapped MAIN video would jump
    // it to its end. (Without a click there was no transition to race.)
    const target = video.duration - 0.4
    if (
      !video.seeking &&
      target > video.currentTime + 1 &&
      now - this.ffLastSeekAt > SEEK_RETRY_MS &&
      (this.skipClickedAt === null || playerShowsAd(this.player))
    ) {
      this.ffLastSeekAt = now
      video.currentTime = target
    }

    if (!this.fastForwarding) {
      this.fastForwarding = true
      // A clicked ad is already counted (and timing-attributed) as
      // 'skip-button'; firing here too would double-count it now that the
      // click and the seek fallback run in the same tick.
      if (this.skipClickedAt === null) this.tallySkip('fast-forward')
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
    const errorScreen = message.closest<HTMLElement>(PLAYABILITY_ERROR_SCREEN)
    if (errorScreen) {
      this.handleHardBlock(errorScreen)
      return
    }

    this.wallsSeen++
    // Dismissible modal wall — same report, same single decision-maker as the
    // hard block; the service worker dedupes across tabs and engine restarts.
    void this.send({ type: 'skipSensei:wallSeen', walls: this.wallsSeen })

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
  private handleHardBlock(errorScreen?: HTMLElement) {
    if (!this.hardBlockSeen) {
      this.hardBlockSeen = true
      this.wallsSeen++
      // Report it and let the service worker decide. Every engine instance
      // used to trip the breaker itself: two watch tabs (or an SPA navigation
      // rebuilding the engine) each read aggressivePruning as still true,
      // each disabled it, and each logged — which is why the activity log
      // showed two "auto-disabled" entries inside the same second and why the
      // wall counts were inflated. One writer, one decision, deduped there.
      void this.send({
        type: 'skipSensei:wallSeen',
        walls: this.wallsSeen,
      })
      log('YouTube hard playback block detected — showing recovery panel')
    }
    this.showHardBlockPanel(errorScreen)
  }

  private showHardBlockPanel(errorScreen?: HTMLElement) {
    if (this.hardBlockPanelDismissed) return
    if (document.getElementById(HARD_BLOCK_ID)) return
    // YouTube paints this enforcement stage in an overlay OUTSIDE the player
    // subtree that stacks above it, so a panel inside #movie_player renders
    // but is fully occluded. Host the panel on the error screen itself; the
    // player is only a fallback for a wall with no error screen to sit on.
    const host =
      errorScreen ?? this.player ?? document.querySelector<HTMLElement>(PLAYER)
    if (!host) return
    if (getComputedStyle(host).position === 'static') {
      host.style.position = 'relative'
    }

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
    const resumeAt = this.lastContentTime
    const resumeNote =
      resumeAt >= MIN_RESUME_SECONDS
        ? ` Either way we’ll pick the video back up at ${formatClock(resumeAt)}.`
        : ''
    body.textContent =
      'YouTube flagged this browser session for ad blocking, so it refuses to ' +
      'play videos — reloading won’t help. Clearing its cookies lifts the flag. ' +
      'Try the first option below — it keeps you signed in, though it doesn’t ' +
      'always work. Clearing everything always does, but signs you out.' +
      resumeNote

    // Order is chosen on COST, not on likelihood. Tested against a real
    // flagged session (Jul 28) the visitor-only clear kept the sign-in but did
    // NOT lift the wall, so it probably won't work. It still leads, because
    // the outcomes aren't symmetric: trying it and failing costs one reload,
    // while skipping it costs a sign-out that can't be taken back. At any
    // non-trivial chance of success that trade is worth taking, and the wipe
    // is one click away regardless. (v0.3.7 briefly led with the wipe on
    // "lead with what works" reasoning — that optimised the wrong variable.)
    //
    // Both labels carry their consequence: this is read by someone whose video
    // just died, who wants it back, and who will click the primary action
    // without reading a word of the paragraph above it.
    const KEEP_LABEL = 'Try it without signing me out'
    const FULL_LABEL = 'Clear all cookies & reload (signs you out)'

    const clear = document.createElement('button')
    clear.className = 'hb-clear'
    clear.textContent = KEEP_LABEL

    const full = document.createElement('button')
    full.className = 'hb-secondary'
    full.textContent = FULL_LABEL

    const run = (
      scope: 'visitor' | 'all',
      btn: HTMLButtonElement,
      label: string,
    ) => {
      btn.disabled = true
      const original = btn.textContent
      btn.textContent = 'Clearing…'
      void this.send<{ ok: boolean } | null>({
        type: 'skipSensei:clearYtCookies',
        scope,
        // Carry the playback position across the reload — clearing cookies
        // also clears YouTube's own resume state, so without this the video
        // restarts from 0:00.
        resumeSeconds: this.lastContentTime,
      }).then((res) => {
        // On success the service worker reloads this tab; only a failure
        // needs handling here.
        if (!res?.ok) {
          btn.disabled = false
          btn.textContent = original ?? label
          body.textContent =
            'Clearing failed — you can clear cookies for youtube.com from ' +
            'the browser’s site settings instead, then reload.'
        }
      })
    }
    clear.addEventListener('click', () => run('visitor', clear, KEEP_LABEL))
    full.addEventListener('click', () => run('all', full, FULL_LABEL))

    // If stage one already ran on this tab and we're looking at the wall
    // again, say so and lead with the wipe that works — repeating a clear
    // that just failed would only waste another reload.
    void this.send<{ triedVisitorClear: boolean } | null>({
      type: 'skipSensei:getWallState',
    }).then((state) => {
      if (!state?.triedVisitorClear || !panel.isConnected) return
      body.textContent =
        'Still blocked after clearing the visitor cookies — YouTube is holding ' +
        'the flag somewhere that survives a partial clear. Clearing everything ' +
        'does lift it, at the cost of signing you out of YouTube.' +
        resumeNote
      clear.remove()
      full.className = 'hb-clear'
    })

    const dismiss = document.createElement('button')
    dismiss.className = 'hb-dismiss'
    dismiss.textContent = "Dismiss and show YouTube's message"
    dismiss.addEventListener('click', () => {
      this.hardBlockPanelDismissed = true
      panel.remove()
    })

    const brand = document.createElement('div')
    brand.className = 'hb-brand'
    const ad = document.createElement('span')
    ad.className = 'ad'
    ad.textContent = 'AD'
    const sensei = document.createElement('span')
    sensei.className = 'sensei'
    sensei.textContent = 'SENSEI'
    brand.append(ad, sensei)

    panel.append(title, body, clear, full, dismiss, brand)
    host.appendChild(panel)
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
