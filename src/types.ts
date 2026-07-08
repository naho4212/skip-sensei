/** Shared message + settings contracts. All keys are skipSensei-namespaced. */

export type LlmProvider =
  | 'builtin'
  | 'gemini'
  | 'anthropic'
  | 'openai'
  | 'groq'
  | 'openrouter'
  | 'ollama'
  | 'openclaw'

/** Providers that authenticate with a user-supplied API key (Ollama is local
 * and keyless; built-in is on-device). OpenClaw's "key" is its gateway token. */
export type KeyedProvider = Exclude<LlmProvider, 'builtin' | 'ollama'>

export interface Settings {
  masterEnabled: boolean
  adEngineEnabled: boolean
  sponsorEngineEnabled: boolean
  /** General web ad blocking (declarativeNetRequest filter lists). Off by default. */
  blockAllAds: boolean
  /** Also block tracking/analytics pixels (separate, larger ruleset). Off by default. */
  blockTrackers: boolean
  /** Hide cookie-consent notices. Off by default. */
  blockCookieNotices: boolean
  /** Block social-media widgets/tracking. Off by default. */
  blockSocial: boolean
  /** Block popups / notification prompts. Off by default. */
  blockPopups: boolean
  /** Hostnames where "Block all ads" is paused (not blocked). */
  allowlist: string[]
  /** Segments below this confidence are never skipped. */
  confidenceThreshold: number
  /** Use the SponsorBlock crowd-sourced database as an instant, deterministic
   * segment source (AI only runs when it returns nothing). On by default. */
  sponsorBlockEnabled: boolean
  /** Which SponsorBlock categories to skip (their API category ids). */
  sponsorBlockCategories: string[]
  showSkipToast: boolean
  /** Let the AI auto-repair YouTube selectors when a DOM change breaks them. */
  aiEnhancements: boolean
  /**
   * Aggressive YouTube ad blocking: strip ad slots from player responses in
   * the page world (uBO-style json-prune) so most ads never start. Most
   * likely feature to be detected by YouTube — off by default, and the ad
   * engine auto-disables it after repeated enforcement walls.
   */
  aggressivePruning: boolean
  /** General web URL-tracking-parameter stripping (AdGuard URL Tracking list).
   * Needs broad host access, so it's requested as an optional permission when
   * enabled. Off by default. */
  blockUrlTracking: boolean
  /** YouTube annoyance removers (cosmetic). All off by default. */
  ytHideShorts: boolean
  ytDismissStillWatching: boolean
  ytDisableEndCards: boolean
  /**
   * Local-only mode: force built-in on-device AI, disable telemetry, and make
   * ZERO external network calls (no cloud LLM, no SponsorBlock, no error
   * reports). A hard privacy guarantee. Off by default.
   */
  localOnlyMode: boolean
  /** Emit [skipSensei] diagnostics to the console. Off by default. */
  debugLogging: boolean
  /** Anonymous sanitized error reports (no usage tracking — CWS stats cover that). On by default, disclosed in options. */
  telemetryEnabled: boolean
  llmProvider: LlmProvider
  /** Per-provider API keys, so switching providers never reuses the wrong key. */
  apiKeys: Partial<Record<KeyedProvider, string>>
  /** Model override; '' = provider default. */
  model: string
  /** OpenClaw gateway chat-completions URL (port is user-configurable). */
  openclawUrl: string
}

export const DEFAULT_SETTINGS: Settings = {
  masterEnabled: true,
  adEngineEnabled: true,
  sponsorEngineEnabled: true,
  blockAllAds: false,
  blockTrackers: false,
  blockCookieNotices: false,
  blockSocial: false,
  blockPopups: false,
  allowlist: [],
  confidenceThreshold: 0.7,
  sponsorBlockEnabled: true,
  sponsorBlockCategories: ['sponsor', 'selfpromo', 'interaction'],
  showSkipToast: true,
  aiEnhancements: true,
  aggressivePruning: false,
  blockUrlTracking: false,
  ytHideShorts: false,
  ytDismissStillWatching: false,
  ytDisableEndCards: false,
  localOnlyMode: false,
  debugLogging: false,
  telemetryEnabled: true,
  llmProvider: 'builtin',
  apiKeys: {},
  model: '',
  openclawUrl: 'http://127.0.0.1:18789/v1/chat/completions',
}

export interface Stats {
  allTimeAdSkips: number
  allTimeSponsorSkips: number
  allTimeWebAdsBlocked: number
}

/** Cloud LLM usage tracking (built-in on-device AI is free/untracked). */
export interface ProviderUsage {
  requests: number
  inputTokens: number
  outputTokens: number
}

export interface ApiUsage {
  /** Local month tag "YYYY-MM" the monthly totals belong to. */
  month: string
  monthly: Partial<Record<LlmProvider, ProviderUsage>>
  /** Pacific date tag "YYYY-MM-DD" the daily counts belong to (providers reset ~midnight PT). */
  day: string
  dailyRequests: Partial<Record<LlmProvider, number>>
}

/** Approximate free-tier daily request cap, for the usage estimate.
 * Gemini free tier (2.5 Flash) is ~250 requests/day and only ~5/minute.
 * Groq is per-model (~1K/day on the 70B default, 14.4K on 8b-instant).
 * OpenRouter :free models are 50/day (1K/day after a one-time $10 top-up). */
export const FREE_TIER_DAILY_LIMIT: Partial<Record<LlmProvider, number>> = {
  gemini: 250,
  groq: 1000,
  openrouter: 50,
}

export const DEFAULT_STATS: Stats = {
  allTimeAdSkips: 0,
  allTimeSponsorSkips: 0,
  allTimeWebAdsBlocked: 0,
}

/** How an ad was neutralized — kept for future metrics/debugging. */
export type AdSkipMethod =
  | 'skip-button'
  | 'fast-forward'
  | 'stuck-recovery'
  | 'pruned'
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

export type SegmentType =
  | 'sponsor'
  | 'self-promo'
  | 'ad-read'
  // Additional SponsorBlock categories (only used when their toggle is on).
  | 'interaction'
  | 'intro'
  | 'outro'
  | 'preview'
  | 'filler'
  | 'music-offtopic'

export interface SponsorSegment {
  start: number
  end: number
  type: SegmentType
  /** 0..1 — model's confidence this is a paid/promotional segment. */
  confidence: number
  /** Set when the user hit "unskip / that was wrong". Never auto-skipped again. */
  dismissed?: boolean
  /** Where the segment came from. 'chapter' = creator "Ad Break" chapter;
   * 'sponsorblock' = SponsorBlock crowd-sourced database; 'llm' = AI. */
  source?: 'llm' | 'chapter' | 'sponsorblock'
}

export type AnalysisStatus =
  | 'ok'
  | 'no-transcript'
  | 'unavailable' // live stream, very short video, …
  | 'error'

/** Bump to invalidate cached analyses produced by older pipeline logic. */
export const ANALYSIS_VERSION = 3

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
  // Content-side operational telemetry → forwarded to reportEvent.
  | {
      type: 'skipSensei:event'
      kind: string
      fields?: Record<string, string>
    }
  | { type: 'skipSensei:getSessionStats' }
  | { type: 'skipSensei:getAnalysis'; videoId: string } // → VideoAnalysis | null
  | {
      type: 'skipSensei:analyzeVideo'
      videoId: string
      lines: TranscriptLine[]
      durationSeconds: number
    } // → VideoAnalysis
  | { type: 'skipSensei:abandonAnalysis'; videoId: string }
  | { type: 'skipSensei:fetchSponsorBlock'; videoId: string } // → SponsorSegment[]
  | {
      type: 'skipSensei:reportCorrection'
      videoId: string
      start: number
      end: number
    }
  | { type: 'skipSensei:checkBuiltinAI' } // → { availability: string }
  | { type: 'skipSensei:getBlockerState' } // → BlockerState
  | { type: 'skipSensei:tabNeedsReload'; needsReload: boolean } // badges the icon for the sender tab
  | { type: 'skipSensei:getTabBlocked'; tabId: number } // → number (ads blocked on that tab)
  | {
      type: 'skipSensei:findSelector'
      html: string
      description: string
    } // → string | null (AI-found CSS selector)
  | {
      type: 'skipSensei:findAdSelectors'
      html: string
      domain: string
    } // → string[] (AI-found ad selectors, also cached for the domain)
  | { type: 'skipSensei:reviewPopup'; html: string } // → boolean (hide this overlay?)
  | { type: 'skipSensei:logActivity'; feature: string; action: string } // content-script action → activity log
  | { type: 'skipSensei:findConsentReject'; html: string } // → string | null (reject-button selector)

export interface SessionStats {
  sessionAdSkips: number
  sessionSponsorSkips: number
  sessionWebAdsBlocked: number
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
  /** Segments that will actually be skipped (above threshold, not dismissed). */
  segments: SponsorSegment[]
  /** Epoch ms when analysis began — popup renders an elapsed timer from it. */
  analyzingSince?: number
  /** Chunk progress while analyzing (absent until the first chunk starts). */
  progressDone?: number
  progressTotal?: number
}
