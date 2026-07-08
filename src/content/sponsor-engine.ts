import { log } from '../log'
import { LIVE_BADGE, VIDEO } from '../selectors'
import { playerShowsAd } from './ad-engine'
import { fetchChapters, fetchTranscript } from '../transcript'
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

/** Creator chapter titles that unambiguously mark advertising. */
const AD_CHAPTER_RE =
  /^\s*(ads?|ad ?breaks?|sponsors?|sponsor ?breaks?|sponsored( segment)?|promos?|advertisements?|commercial( break)?s?)\s*$/i

/** Sanity cap: an "ad break" chapter longer than this is probably mislabeled. */
const CHAPTER_AD_MAX_SECONDS = 180

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
  analyzingSince = Date.now()
  progressDone: number | undefined
  progressTotal: number | undefined
  private segments: SponsorSegment[] = []
  private chapterSegments: SponsorSegment[] = []
  /** Deterministic segments (creator chapters + SponsorBlock), merged. The AI
   * adds its own findings on top of these; these always win an overlap. */
  private externalSegments: SponsorSegment[] = []
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
    this.progressDone = done
    this.progressTotal = total
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

    // A pre-roll ad plays in the SAME <video> element, so right now
    // video.duration may be the AD's duration — sampling it mid-ad marks a
    // long video "too short" and truncates LLM segments to the ad's length.
    await this.waitUntilAdFree(video)
    if (this.stopped) return

    // Creator-declared "Ad Break" chapters are a deterministic signal: fetch
    // them first so those skips are armed instantly, independent of the LLM.
    this.chapterSegments = await this.loadChapterSegments(video.duration)
    if (this.stopped) return
    if (this.chapterSegments.length > 0) {
      this.segments = [...this.chapterSegments]
      log('ad chapters:', describeSegments(this.chapterSegments))
    }

    // SponsorBlock: crowd-sourced, instant, exact. Merge it with the chapter
    // segments as the deterministic base, arm those immediately, then ALSO run
    // the AI on top — the two sources catch different things (SponsorBlock has
    // exact community timestamps; the AI finds reads nobody submitted), so
    // merging both gives the most complete coverage.
    const sbSegments =
      (await this.send<SponsorSegment[]>({
        type: 'skipSensei:fetchSponsorBlock',
        videoId: this.videoId,
      })) ?? []
    if (this.stopped) return
    this.externalSegments = this.dedupeOverlaps([
      ...this.chapterSegments,
      ...sbSegments,
    ])
    if (this.externalSegments.length > 0) {
      this.segments = [...this.externalSegments]
      if (sbSegments.length > 0) log('SponsorBlock:', describeSegments(sbSegments))
      // Armed with deterministic segments; the AI may add more below.
      this.setStatus('ready')
    }

    await this.analyze(video)
  }

  /** Merge a set of segments, dropping any that overlap an earlier one.
   * Earlier entries (chapters, then SponsorBlock) win. */
  private dedupeOverlaps(all: SponsorSegment[]): SponsorSegment[] {
    const kept: SponsorSegment[] = []
    for (const seg of all) {
      if (!kept.some((m) => seg.start < m.end && seg.end > m.start)) kept.push(seg)
    }
    return kept.sort((a, b) => a.start - b.start)
  }

  private async loadChapterSegments(
    durationSeconds: number,
  ): Promise<SponsorSegment[]> {
    const chapters = await fetchChapters(this.videoId)
    const segments: SponsorSegment[] = []
    chapters.forEach((chapter, i) => {
      if (!AD_CHAPTER_RE.test(chapter.title)) return
      const nextStart = chapters[i + 1]?.start
      const hardEnd = Number.isFinite(durationSeconds)
        ? durationSeconds
        : chapter.start + CHAPTER_AD_MAX_SECONDS
      const end = Math.min(
        nextStart ?? hardEnd,
        chapter.start + CHAPTER_AD_MAX_SECONDS,
        hardEnd,
      )
      if (end > chapter.start + 1) {
        segments.push({
          start: chapter.start,
          end,
          type: 'ad-read',
          confidence: 1,
          source: 'chapter',
        })
      }
    })
    return segments
  }

  /** Deterministic segments (chapters + SponsorBlock) win; AI segments that
   * overlap one are dropped, the rest are added. */
  private mergeSegments(llmSegments: SponsorSegment[]): SponsorSegment[] {
    const merged = [...this.externalSegments]
    for (const segment of llmSegments) {
      const overlaps = merged.some(
        (c) => segment.start < c.end && segment.end > c.start,
      )
      if (!overlaps) merged.push({ ...segment, source: 'llm' })
    }
    return merged.sort((a, b) => a.start - b.start)
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
      this.setStatusOrKeepExternal('unavailable', 'live stream has no complete transcript')
      return
    }
    const durationSeconds = video.duration
    if (durationSeconds < MIN_VIDEO_SECONDS) {
      this.setStatusOrKeepExternal('unavailable', 'video too short to scan')
      return
    }

    const transcript = await fetchTranscript(this.videoId)
    if (this.stopped) return
    log('transcript fetch:', transcript.status, `${transcript.lines.length} lines`)

    if (transcript.status === 'no-transcript') {
      this.setStatusOrKeepExternal('no-transcript')
      return
    }
    if (transcript.status === 'error') {
      this.setStatusOrKeepExternal('error', 'Could not load transcript')
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
      this.setStatusOrKeepExternal('error', 'Analysis did not complete')
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
      this.segments = this.mergeSegments(analysis.segments)
      this.setStatus('ready')
    } else {
      // SponsorBlock/chapter segments (if any) stay active even when the LLM
      // path is unavailable.
      this.setStatusOrKeepExternal(
        analysis.status === 'no-transcript' ? 'no-transcript' : analysis.status,
        analysis.reason,
      )
    }
  }

  /** Report a non-ok status only when there are no deterministic
   * (SponsorBlock/chapter) segments to fall back on; otherwise those keep us
   * 'ready' so their skips stay armed. */
  private setStatusOrKeepExternal(
    status: SponsorEngineStatus,
    reason?: string,
  ) {
    if (this.externalSegments.length > 0) this.setStatus('ready')
    else this.setStatus(status, reason)
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

  /** Resolve once no ad is on screen and the video's own metadata is loaded.
   * Ads are usually gone in seconds (the ad engine fast-forwards them); after
   * ~2 minutes proceed anyway rather than never analyzing. */
  private waitUntilAdFree(video: HTMLVideoElement): Promise<void> {
    return new Promise((resolve) => {
      let attempts = 0
      const poll = () => {
        if (this.stopped) return resolve()
        if (!playerShowsAd() && video.readyState >= 1) {
          if (this.reason === 'waiting for the ad to finish') {
            this.reason = undefined
          }
          return resolve()
        }
        if (this.status === 'analyzing') {
          this.reason = 'waiting for the ad to finish'
        }
        if (++attempts > 240) return resolve()
        setTimeout(poll, 500)
      }
      poll()
    })
  }

  private checkPlayback() {
    if (this.stopped || !this.video || this.segments.length === 0) return
    // Orphaned by an extension reload — park quietly (see AdEngine.check).
    if (!chrome.runtime?.id) {
      this.stop()
      return
    }
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
    // sendMessage throws SYNCHRONOUSLY when the extension context is
    // invalidated — .catch() alone never sees it.
    try {
      return chrome.runtime.sendMessage(message).catch(() => null)
    } catch {
      return Promise.resolve(null)
    }
  }
}
