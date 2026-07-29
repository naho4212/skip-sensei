import { PLAYER, VIDEO } from '../selectors'
import { log } from '../log'
import { getResumePosition } from '../storage'
import type { Message } from '../types'

/** Position WRITES go through the service worker, whose single chain
 * serializes all tabs — writing the shared map directly from here raced
 * other watch tabs (each content-script context has its own storage-module
 * instance, so its chain guards nothing beyond this tab). Reads stay direct.
 * sendMessage throws synchronously in an orphaned context — swallow both. */
function sendToSw(message: Message): void {
  try {
    chrome.runtime.sendMessage(message).catch(() => {})
  } catch {
    /* extension reloaded out from under us — nothing to save to */
  }
}

/**
 * Never lose your place on a reload.
 *
 * YouTube restores playback position from watch history — which is exactly
 * what the anti-adblock cookie clear destroys, and which never applied to a
 * signed-out viewer at all. So keep a local copy of where the user is and put
 * them back on the next load of the same video.
 *
 * The `t=` URL the cookie-clear path adds is NOT redundant with this: it works
 * even when the wall stops our content script from ever seeing playback. This
 * covers the other cases — a manual reload, a crash, reopening the video in a
 * new tab.
 */

/** Sample no faster than this; the position only needs to be roughly right. */
const SAVE_EVERY_MS = 5000
/** Below this, restoring is more annoying than helpful — you've barely started. */
const MIN_RESTORE_SECONDS = 30
/** Within this of the end, the video is finished; restoring would strand the
 * user on the outro every time they reopen it. */
const END_MARGIN_SECONDS = 15
/** If playback is already past this, something restored it before us (YouTube's
 * own history, or a `t=` in the URL) — leave it alone. */
const ALREADY_POSITIONED_SECONDS = 5
/** Attach polling: the player element appears well after document_start. */
const ATTACH_TRIES = 80
const ATTACH_EVERY_MS = 250

export class ResumePositionTracker {
  private video: HTMLVideoElement | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private attachTimer: ReturnType<typeof setTimeout> | null = null
  private tries = 0
  private restoreDone = false
  private lastSaved = -1

  constructor(private videoId: string) {}

  start() {
    // An explicit timestamp in the URL is the user (or our own cookie-clear
    // navigation) asking for a specific point — never override it.
    if (hasExplicitTime()) {
      this.restoreDone = true
      log('resume: URL carries an explicit timestamp; not restoring')
    }
    this.attach()
  }

  stop() {
    if (this.timer !== null) clearInterval(this.timer)
    if (this.attachTimer !== null) clearTimeout(this.attachTimer)
    this.timer = null
    this.attachTimer = null
    // Save one last time so a fast SPA navigation away doesn't lose the last
    // few seconds of progress.
    this.save()
    this.video = null
  }

  private attach() {
    const video = document.querySelector<HTMLVideoElement>(VIDEO)
    if (!video) {
      if (this.tries++ >= ATTACH_TRIES) return
      this.attachTimer = setTimeout(() => this.attach(), ATTACH_EVERY_MS)
      return
    }
    this.video = video
    void this.maybeRestore()
    this.timer = setInterval(() => this.save(), SAVE_EVERY_MS)
  }

  /** Put the user back where they were, once, if that's clearly what they want. */
  private async maybeRestore() {
    if (this.restoreDone) return
    this.restoreDone = true
    const stored = await getResumePosition(this.videoId)
    if (stored === null || stored < MIN_RESTORE_SECONDS) return
    const video = this.video
    if (!video) return
    // Wait for metadata: duration is NaN until then, and seeking before the
    // media is ready is silently dropped.
    if (!Number.isFinite(video.duration) || video.duration === 0) {
      video.addEventListener('loadedmetadata', () => void this.restore(stored), {
        once: true,
      })
      return
    }
    void this.restore(stored)
  }

  private async restore(stored: number) {
    const video = this.video
    if (!video || !Number.isFinite(video.duration)) return
    // Finished last time — start it over rather than dropping the user on the
    // outro, and drop the stale entry.
    if (stored >= video.duration - END_MARGIN_SECONDS) {
      sendToSw({ type: 'skipSensei:resumeForget', videoId: this.videoId })
      return
    }
    // Something already positioned this (YouTube's own history) — don't fight it.
    if (video.currentTime > ALREADY_POSITIONED_SECONDS) return
    // An ad is playing: currentTime belongs to the AD, and seeking it would
    // fast-forward the ad rather than the video. The engine handles ads; we
    // just wait for the real content.
    if (playerShowsAd()) {
      this.restoreDone = false
      setTimeout(() => void this.maybeRestore(), 1000)
      return
    }
    video.currentTime = stored
    log(`resume: restored to ${Math.floor(stored)}s`)
  }

  private save() {
    const video = this.video
    if (!video || playerShowsAd()) return
    const t = video.currentTime
    if (!Number.isFinite(t) || t < MIN_RESTORE_SECONDS) return
    // Watched to the end — forget it, so reopening starts clean.
    if (Number.isFinite(video.duration) && t >= video.duration - END_MARGIN_SECONDS) {
      sendToSw({ type: 'skipSensei:resumeForget', videoId: this.videoId })
      this.lastSaved = -1
      return
    }
    if (Math.abs(t - this.lastSaved) < 1) return
    this.lastSaved = t
    sendToSw({ type: 'skipSensei:resumeSave', videoId: this.videoId, seconds: t })
  }
}

/** `t`/`start` in the URL means a specific point was requested. */
function hasExplicitTime(): boolean {
  const params = new URLSearchParams(location.search)
  return params.has('t') || params.has('start')
}

function playerShowsAd(): boolean {
  const player = document.querySelector<HTMLElement>(PLAYER)
  return !!player && /(^|\s)ad-(showing|interrupting)(\s|$)/.test(player.className)
}
