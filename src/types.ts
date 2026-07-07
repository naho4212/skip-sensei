/** Shared message + settings contracts. All keys are skipSensei-namespaced. */

export type LlmProvider = 'builtin' | 'anthropic' | 'openai'

export interface Settings {
  masterEnabled: boolean
  adEngineEnabled: boolean
  sponsorEngineEnabled: boolean
  /** Segments below this confidence are never skipped. */
  confidenceThreshold: number
  showSkipToast: boolean
  llmProvider: LlmProvider
  /** Cloud-provider API key; unused for 'builtin'. */
  apiKey: string
  /** Model override; '' = provider default. */
  model: string
}

export const DEFAULT_SETTINGS: Settings = {
  masterEnabled: true,
  adEngineEnabled: true,
  sponsorEngineEnabled: true,
  confidenceThreshold: 0.7,
  showSkipToast: true,
  llmProvider: 'builtin',
  apiKey: '',
  model: '',
}

export interface Stats {
  allTimeAdSkips: number
  allTimeSponsorSkips: number
}

export const DEFAULT_STATS: Stats = {
  allTimeAdSkips: 0,
  allTimeSponsorSkips: 0,
}

/** How an ad was neutralized — kept for future metrics/debugging. */
export type AdSkipMethod =
  | 'skip-button'
  | 'fast-forward'
  | 'overlay-removed'
  | 'pause-overlay-dismissed'

// ---------------------------------------------------------------------------
// Transcript + sponsor segments
// ---------------------------------------------------------------------------

export interface TranscriptLine {
  /** Seconds from video start. */
  start: number
  end: number
  text: string
}

export type SegmentType = 'sponsor' | 'self-promo' | 'ad-read'

export interface SponsorSegment {
  start: number
  end: number
  type: SegmentType
  /** 0..1 — model's confidence this is a paid/promotional segment. */
  confidence: number
  /** Set when the user hit "unskip / that was wrong". Never auto-skipped again. */
  dismissed?: boolean
}

export type AnalysisStatus =
  | 'ok'
  | 'no-transcript'
  | 'unavailable' // live stream, very short video, …
  | 'error'

/** Bump to invalidate cached analyses produced by older pipeline logic. */
export const ANALYSIS_VERSION = 2

export interface VideoAnalysis {
  videoId: string
  status: AnalysisStatus
  /** Human-readable detail for 'unavailable' / 'error'. */
  reason?: string
  segments: SponsorSegment[]
  provider?: LlmProvider
  analyzedAt: number
  version?: number
}

// ---------------------------------------------------------------------------
// Messages: content script / popup / options → service worker
// ---------------------------------------------------------------------------

export type Message =
  | { type: 'skipSensei:adSkipped'; method: AdSkipMethod }
  | { type: 'skipSensei:sponsorSkipped'; videoId: string }
  | { type: 'skipSensei:getSessionStats' }
  | { type: 'skipSensei:getAnalysis'; videoId: string } // → VideoAnalysis | null
  | {
      type: 'skipSensei:analyzeVideo'
      videoId: string
      lines: TranscriptLine[]
      durationSeconds: number
    } // → VideoAnalysis
  | { type: 'skipSensei:abandonAnalysis'; videoId: string }
  | {
      type: 'skipSensei:reportCorrection'
      videoId: string
      start: number
      end: number
    }
  | { type: 'skipSensei:checkBuiltinAI' } // → { availability: string }

export interface SessionStats {
  sessionAdSkips: number
  sessionSponsorSkips: number
}

// ---------------------------------------------------------------------------
// Messages: popup → content script
// ---------------------------------------------------------------------------

export type TabMessage =
  | { type: 'skipSensei:getPageStatus' }
  | {
      type: 'skipSensei:analysisProgress'
      videoId: string
      done: number
      total: number
    }

export type SponsorEngineStatus =
  | 'off'
  | 'analyzing'
  | 'ready'
  | 'no-transcript'
  | 'unavailable'
  | 'error'

export interface PageStatus {
  isWatchPage: boolean
  adEngineActive: boolean
  sponsorStatus: SponsorEngineStatus
  sponsorReason?: string
  segmentCount: number
}
