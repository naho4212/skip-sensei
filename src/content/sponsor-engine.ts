import { VIDEO } from '../selectors'
import { fetchTranscript } from '../transcript'
import type {
  Message,
  Settings,
  SponsorEngineStatus,
  SponsorSegment,
  VideoAnalysis,
} from '../types'
import { removeToast, showSkipToast } from './toast'

/** Videos shorter than this skip the LLM call — sponsor reads are rare and cost isn't worth it. */
const MIN_VIDEO_SECONDS = 120

/**
 * Sponsor Engine: obtains sponsor segments for the current video (cache → LLM
 * via the service worker) and skips playback past them. One instance per
 * watch page; SPA navigation tears it down.
 */
export class SponsorEngine {
  status: SponsorEngineStatus = 'analyzing'
  reason: string | undefined
  private segments: SponsorSegment[] = []
  private stopped = false
  private video: HTMLVideoElement | null = null
  /** Segment starts already skipped/dismissed this page — prevents skip loops. */
  private handled = new Set<number>()
  private onTimeUpdate = () => this.checkPlayback()
  private videoAttachTimer: number | null = null

  constructor(
    private videoId: string,
    private getSettings: () => Settings,
  ) {}

  get segmentCount(): number {
    return this.segments.length
  }

  start() {
    void this.analyze()
    this.attachWhenVideoExists()
  }

  stop() {
    this.stopped = true
    this.video?.removeEventListener('timeupdate', this.onTimeUpdate)
    this.video = null
    if (this.videoAttachTimer !== null) clearTimeout(this.videoAttachTimer)
    removeToast()
    // Let the service worker abort the LLM call if no other tab wants it.
    this.send({ type: 'skipSensei:abandonAnalysis', videoId: this.videoId })
  }

  private async analyze() {
    // Cache first: no transcript fetch, no LLM call on a re-watch.
    const cached = await this.send<VideoAnalysis | null>({
      type: 'skipSensei:getAnalysis',
      videoId: this.videoId,
    })
    if (this.stopped) return
    if (cached) {
      this.applyAnalysis(cached)
      return
    }

    const transcript = await fetchTranscript(this.videoId)
    if (this.stopped) return

    if (transcript.status === 'live') {
      this.setStatus('unavailable', 'Live stream — no complete transcript')
      return
    }
    if (transcript.status === 'no-transcript') {
      this.setStatus('no-transcript')
      return
    }
    if (transcript.status === 'error') {
      this.setStatus('error', 'Could not load transcript')
      return
    }
    if (
      transcript.durationSeconds > 0 &&
      transcript.durationSeconds < MIN_VIDEO_SECONDS
    ) {
      this.setStatus('unavailable', 'Video too short to analyze')
      return
    }

    const analysis = await this.send<VideoAnalysis | null>({
      type: 'skipSensei:analyzeVideo',
      videoId: this.videoId,
      lines: transcript.lines,
      durationSeconds: transcript.durationSeconds,
    })
    if (this.stopped || !analysis) return
    this.applyAnalysis(analysis)
  }

  private applyAnalysis(analysis: VideoAnalysis) {
    if (analysis.status === 'ok') {
      this.segments = analysis.segments
      this.setStatus('ready')
    } else {
      this.setStatus(
        analysis.status === 'no-transcript' ? 'no-transcript' : analysis.status,
        analysis.reason,
      )
    }
  }

  private setStatus(status: SponsorEngineStatus, reason?: string) {
    this.status = status
    this.reason = reason
  }

  // -------------------------------------------------------------------------
  // Playback watcher
  // -------------------------------------------------------------------------

  private attachWhenVideoExists(attempt = 0) {
    if (this.stopped) return
    const video = document.querySelector<HTMLVideoElement>(VIDEO)
    if (!video) {
      if (attempt < 40) {
        this.videoAttachTimer = window.setTimeout(
          () => this.attachWhenVideoExists(attempt + 1),
          250,
        )
      }
      return
    }
    this.video = video
    video.addEventListener('timeupdate', this.onTimeUpdate)
  }

  private checkPlayback() {
    if (this.stopped || !this.video || this.segments.length === 0) return
    const settings = this.getSettings()
    const time = this.video.currentTime

    for (const segment of this.segments) {
      if (segment.dismissed || this.handled.has(segment.start)) continue
      if (segment.confidence < settings.confidenceThreshold) continue
      const inSegment = time >= segment.start && time < segment.end - 0.5
      // Only skip when there's meaningfully more segment left than a seek costs.
      if (!inSegment || segment.end - time < 1) continue

      this.handled.add(segment.start)
      this.video.currentTime = segment.end
      this.send({ type: 'skipSensei:sponsorSkipped', videoId: this.videoId })
      if (settings.showSkipToast) {
        showSkipToast(segment.end - segment.start, () => this.unskip(segment))
      }
      return
    }
  }

  /** "That was wrong": go back, never auto-skip this segment again, log it. */
  private unskip(segment: SponsorSegment) {
    segment.dismissed = true
    if (this.video) this.video.currentTime = segment.start
    this.send({
      type: 'skipSensei:reportCorrection',
      videoId: this.videoId,
      start: segment.start,
      end: segment.end,
    })
  }

  private send<T = void>(message: Message): Promise<T | null> {
    return chrome.runtime.sendMessage(message).catch(() => null)
  }
}
