import { LIVE_BADGE, VIDEO } from '../selectors'
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

const log = (...args: unknown[]) => console.log('[skipSensei]', ...args)

const describeSegments = (segments: SponsorSegment[]) =>
  segments
    .map(
      (s) =>
        `${Math.round(s.start)}-${Math.round(s.end)}s ${s.type}@${s.confidence}`,
    )
    .join(', ') || '(none)'

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
  /**
   * Wall-clock time of each segment's last skip. A short cooldown (instead of
   * a once-per-page flag) prevents seek-race double skips while still
   * re-skipping when the user rewinds back into the segment later.
   */
  private lastSkipAt = new Map<number, number>()
  private onTimeUpdate = () => this.checkPlayback()

  constructor(
    private videoId: string,
    private getSettings: () => Settings,
  ) {}

  get segmentCount(): number {
    return this.segments.length
  }

  /** Segments the watcher will actually skip, for the popup's timestamp list. */
  get activeSegments(): SponsorSegment[] {
    const threshold = this.getSettings().confidenceThreshold
    return this.segments.filter(
      (s) => !s.dismissed && s.confidence >= threshold,
    )
  }

  /** Chunk progress from the service worker, surfaced in the popup status. */
  noteProgress(videoId: string, done: number, total: number) {
    if (videoId !== this.videoId || this.status !== 'analyzing') return
    if (total > 1 && done < total) {
      this.reason = `chunk ${done + 1} of ${total}`
    }
  }

  start() {
    void this.run()
  }

  stop() {
    this.stopped = true
    this.video?.removeEventListener('timeupdate', this.onTimeUpdate)
    this.video = null
    removeToast()
    // Let the service worker abort the LLM call if no other tab wants it.
    this.send({ type: 'skipSensei:abandonAnalysis', videoId: this.videoId })
  }

  private async run() {
    const video = await this.waitForVideo()
    if (this.stopped) return
    if (!video) {
      this.setStatus('error', 'Video player not found')
      return
    }
    this.video = video
    video.addEventListener('timeupdate', this.onTimeUpdate)
    await this.analyze(video)
  }

  private async analyze(video: HTMLVideoElement) {
    // Cache first: no transcript fetch, no LLM call on a re-watch.
    const cached = await this.send<VideoAnalysis | null>({
      type: 'skipSensei:getAnalysis',
      videoId: this.videoId,
    })
    if (this.stopped) return
    if (cached) {
      log('using cached analysis', cached.status, describeSegments(cached.segments))
      this.applyAnalysis(cached)
      return
    }

    if (document.querySelector(LIVE_BADGE) || !Number.isFinite(video.duration)) {
      this.setStatus('unavailable', 'Live stream — no complete transcript')
      return
    }
    const durationSeconds = video.duration
    if (durationSeconds < MIN_VIDEO_SECONDS) {
      this.setStatus('unavailable', 'Video too short to analyze')
      return
    }

    const transcript = await fetchTranscript(this.videoId)
    if (this.stopped) return
    log('transcript fetch:', transcript.status, `${transcript.lines.length} lines`)

    if (transcript.status === 'no-transcript') {
      this.setStatus('no-transcript')
      return
    }
    if (transcript.status === 'error') {
      this.setStatus('error', 'Could not load transcript')
      return
    }

    const analysis = await this.send<VideoAnalysis | null>({
      type: 'skipSensei:analyzeVideo',
      videoId: this.videoId,
      lines: transcript.lines,
      durationSeconds,
    })
    if (this.stopped) return
    if (!analysis) {
      this.setStatus('error', 'Analysis did not complete')
      return
    }
    log(
      'analysis:',
      analysis.status,
      analysis.reason ?? '',
      describeSegments(analysis.segments),
    )
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
    if (reason) log('status:', status, '—', reason)
  }

  // -------------------------------------------------------------------------
  // Playback watcher
  // -------------------------------------------------------------------------

  /** The player and its metadata render asynchronously after SPA navigation. */
  private waitForVideo(): Promise<HTMLVideoElement | null> {
    return new Promise((resolve) => {
      let attempts = 0
      const poll = () => {
        if (this.stopped) return resolve(null)
        const video = document.querySelector<HTMLVideoElement>(VIDEO)
        // readyState ≥ 1 = metadata (duration) is known.
        if (video && video.readyState >= 1) return resolve(video)
        if (++attempts > 80) return resolve(video)
        setTimeout(poll, 250)
      }
      poll()
    })
  }

  private checkPlayback() {
    if (this.stopped || !this.video || this.segments.length === 0) return
    const settings = this.getSettings()
    const time = this.video.currentTime

    for (const segment of this.segments) {
      if (segment.dismissed) continue
      const lastSkip = this.lastSkipAt.get(segment.start)
      if (lastSkip !== undefined && Date.now() - lastSkip < 5000) continue
      if (segment.confidence < settings.confidenceThreshold) continue
      const inSegment = time >= segment.start && time < segment.end - 0.5
      // Only skip when there's meaningfully more segment left than a seek costs.
      if (!inSegment || segment.end - time < 1) continue

      this.lastSkipAt.set(segment.start, Date.now())
      this.video.currentTime = segment.end
      log(`skipped sponsor segment ${segment.start}s → ${segment.end}s`)
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
