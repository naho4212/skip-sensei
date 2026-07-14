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
  /** Block known malware/phishing domains (URLhaus list). On by default —
   * pure protection, independent of ad blocking. */
  blockMalware: boolean
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
   * the page world (uBO-style json-prune) plus outbound player-request context
   * spoofing and HLS/DASH ad-segment stripping, so most ads never start. The
   * page-world patches are cloaked (patched natives report `[native code]`) so
   * YouTube's integrity checks don't notice. Off by default (opt-in): it's the
   * riskiest feature, and the ad engine keeps a circuit breaker that falls back
   * to reactive skipping if repeated enforcement walls appear.
   */
  aggressivePruning: boolean
  /**
   * Anti-adblock defusing: inject MAIN-world scriptlets (set-constant,
   * spoof-css, abort-on-property-read, prevent-setTimeout/addEventListener) to
   * neutralize adblock-detection and ad-reinsertion on general sites. Part of
   * "Block all ads". Only active where the extension has host access — the
   * broad-web layer needs the optional all-sites permission (e.g. granted for
   * URL-tracking protection); dormant until then. On by default.
   */
  defuseAntiAdblock: boolean
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

/** Per-tab blocked-item counts split by kind, for the popup's "blocked here"
 * breakdown. The badge shows the sum. `ads` folds in cosmetic element hides. */
export interface BlockBreakdown {
  ads: number
  trackers: number
  cookies: number
  social: number
  popups: number
  links: number
  malware: number
}

/** Display order + labels for the breakdown (singular/plural handled at render). */
export const BLOCK_CATEGORY_LABELS: Array<[keyof BlockBreakdown, string]> = [
  ['ads', 'ad'],
  ['trackers', 'tracker'],
  ['cookies', 'cookie notice'],
  ['popups', 'popup'],
  ['social', 'social widget'],
  ['links', 'tracking link'],
  ['malware', 'malware block'],
]

export const DEFAULT_SETTINGS: Settings = {
  masterEnabled: true,
  adEngineEnabled: true,
  sponsorEngineEnabled: true,
  blockAllAds: false,
  blockTrackers: false,
  blockCookieNotices: false,
  blockSocial: false,
  blockPopups: false,
  blockMalware: true,
  allowlist: [],
  confidenceThreshold: 0.7,
  sponsorBlockEnabled: true,
  sponsorBlockCategories: ['sponsor', 'selfpromo', 'interaction'],
  showSkipToast: true,
  aiEnhancements: true,
  aggressivePruning: false,
  defuseAntiAdblock: true,
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
  /** YouTube display ads (feed/sidebar/masthead) hidden — folded into the
   *  popup's YouTube card, kept separate from video ad-skips. */
  allTimeYtAdsHidden: number
  allTimeWebAdsBlocked: number
  allTimeTrackersBlocked: number
  allTimeCookiesBlocked: number
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
  allTimeYtAdsHidden: 0,
  allTimeWebAdsBlocked: 0,
  allTimeTrackersBlocked: 0,
  allTimeCookiesBlocked: 0,
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
  // count: how many ad breaks this event represents (aggressive-mode pruning
  // reports the number of slots removed for a video); defaults to 1.
  | { type: 'skipSensei:adSkipped'; method: AdSkipMethod; count?: number }
  | { type: 'skipSensei:sponsorSkipped'; videoId: string }
  // Live per-tab hidden-ad tally: `count` is the page total (badge snapshot),
  // `added` is how many are new since the last message (fed to lifetime stats).
  | { type: 'skipSensei:cosmeticHideCount'; count: number; added: number }
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
  | { type: 'skipSensei:getRulesetInfo' } // → RulesetInfo (counts + live loaded)
  | { type: 'skipSensei:resetStats' } // → { ok: true }; zeroes lifetime+session stats
  // → string[] of domain-specific cosmetic selectors for the sender's hostname
  | { type: 'skipSensei:getCosmeticFilters'; hostname: string }
  | { type: 'skipSensei:adblockWall'; hostname: string } // site is showing an ad-blocker wall
  // → { ok: boolean }; clears youtube.com cookies + the backoff flag, then reloads the sender tab
  | { type: 'skipSensei:clearYtCookies' }
  | { type: 'skipSensei:tabNeedsReload'; needsReload: boolean } // badges the icon for the sender tab
  | { type: 'skipSensei:getTabBlocked'; tabId: number } // → BlockBreakdown (per-type blocks on that tab)
  | {
      type: 'skipSensei:findSelector'
      html: string
      description: string
    } // → string | null (AI-found CSS selector)
  | {
      type: 'skipSensei:verifyAdCandidates'
      candidates: Array<{ index: number; html: string }>
    } // → number[] (indexes the AI confirmed as ads; fail-closed empty)
  | { type: 'skipSensei:reviewPopup'; html: string; desc?: string } // → boolean (hide this overlay?)
  | { type: 'skipSensei:logActivity'; feature: string; action: string } // content-script action → activity log
  | { type: 'skipSensei:findConsentReject'; html: string } // → string | null (reject-button selector)

export interface SessionStats {
  sessionAdSkips: number
  sessionSponsorSkips: number
  sessionYtAdsHidden: number
  sessionWebAdsBlocked: number
  sessionTrackersBlocked: number
  sessionCookiesBlocked: number
}

// ---------------------------------------------------------------------------
// Messages: popup → content script
// ---------------------------------------------------------------------------

export type TabMessage =
  | { type: 'skipSensei:getPageStatus' }
  | { type: 'skipSensei:hasYouTubeEmbed' } // → boolean (page embeds a YT video)
  | {
      type: 'skipSensei:analysisProgress'
      videoId: string
      done: number
      total: number
    }
  | { type: 'skipSensei:getHiddenElements' } // → HiddenElement[]
  | { type: 'skipSensei:scanForAds' } // → HiddenElement[]
  | { type: 'skipSensei:rejectHiddenSelector'; selector: string }
  | { type: 'skipSensei:confirmHiddenSelector'; selector: string }
  | { type: 'skipSensei:getSiteFeedback' } // → { rejectedCount: number }
  | { type: 'skipSensei:resetSiteFeedback' } // → HiddenElement[]

/** One hidden ad selector active on the page, for the popup review UI. */
export interface HiddenElement {
  selector: string
  count: number
  tag: string
  text: string
  /** 'list' = filter-list selector, 'ai' = AI gap-filler, 'youtube' = YT ads. */
  source: 'list' | 'ai' | 'youtube'
  /** AI proposed it but the safety guard kept it visible (looks like real UI).
   * Shown in the review so the user can 👍 (hide it anyway) or 👎 (dismiss). */
  vetoed?: boolean
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
