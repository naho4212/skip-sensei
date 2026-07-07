import {
  analyzeTranscript,
  builtinAvailability,
  findAdSelectors,
  findConsentReject,
  findElementSelector,
  RateLimitError,
  resolveProvider,
  reviewPopup,
} from './llm-client'
import { getBlockerState, initNetBlocker } from './net-blocker'
import {
  addGapfillSelectors,
  getCachedAnalysis,
  getSettings,
  incrementStat,
  recordCorrection,
  setCachedAnalysis,
} from './storage'
import {
  ANALYSIS_VERSION,
  type Message,
  type SessionStats,
  type TranscriptLine,
  type VideoAnalysis,
} from './types'

/**
 * Service worker: LLM analysis orchestration, per-videoId segment caching,
 * session counters.
 */

const SESSION_STATS_KEY = 'skipSensei.sessionStats'

const EMPTY_SESSION: SessionStats = {
  sessionAdSkips: 0,
  sessionSponsorSkips: 0,
  sessionWebAdsBlocked: 0,
}

async function getSessionStats(): Promise<SessionStats> {
  const result = await chrome.storage.session.get(SESSION_STATS_KEY)
  return { ...EMPTY_SESSION, ...(result[SESSION_STATS_KEY] ?? {}) }
}

async function recordSkip(kind: 'ad' | 'sponsor') {
  await incrementStat(kind === 'ad' ? 'allTimeAdSkips' : 'allTimeSponsorSkips')
  const session = await getSessionStats()
  if (kind === 'ad') session.sessionAdSkips += 1
  else session.sessionSponsorSkips += 1
  await chrome.storage.session.set({ [SESSION_STATS_KEY]: session })
}

async function recordWebBlocks(n: number) {
  await incrementStat('allTimeWebAdsBlocked', n)
  const session = await getSessionStats()
  session.sessionWebAdsBlocked += n
  await chrome.storage.session.set({ [SESSION_STATS_KEY]: session })
}

// ---------------------------------------------------------------------------
// Analysis pipeline
// ---------------------------------------------------------------------------

interface InflightAnalysis {
  promise: Promise<VideoAnalysis>
  controller: AbortController
  /** Tabs still waiting; when it drops to zero the LLM call is aborted. */
  waiters: number
}

const inflight = new Map<string, InflightAnalysis>()

/**
 * MV3 terminates a service worker that looks idle — and a long await on an
 * on-device model looks idle. Touching an extension API every 20s while an
 * analysis is in flight resets the idle clock.
 */
let keepaliveTimer: ReturnType<typeof setInterval> | null = null

function updateKeepalive() {
  const active = inflight.size > 0
  if (active && keepaliveTimer === null) {
    keepaliveTimer = setInterval(
      () => void chrome.runtime.getPlatformInfo(),
      20_000,
    )
  } else if (!active && keepaliveTimer !== null) {
    clearInterval(keepaliveTimer)
    keepaliveTimer = null
  }
}

function reportProgress(
  tabId: number | undefined,
  videoId: string,
  done: number,
  total: number,
) {
  if (tabId === undefined) return
  chrome.tabs
    .sendMessage(tabId, {
      type: 'skipSensei:analysisProgress',
      videoId,
      done,
      total,
    })
    .catch(() => {})
}

/**
 * Cached analysis, unless it's a zero-segment result from the weaker built-in
 * model and the user has since configured a cloud provider — then re-analyze.
 */
async function usableCachedAnalysis(
  videoId: string,
): Promise<VideoAnalysis | null> {
  const cached = await getCachedAnalysis(videoId)
  if (!cached) return null
  if (cached.version !== ANALYSIS_VERSION) return null
  if (
    cached.status === 'ok' &&
    cached.segments.length === 0 &&
    cached.provider === 'builtin' &&
    resolveProvider(await getSettings()) !== 'builtin'
  ) {
    return null
  }
  return cached
}

async function analyzeVideo(
  videoId: string,
  lines: TranscriptLine[],
  durationSeconds: number,
  tabId: number | undefined,
): Promise<VideoAnalysis> {
  const cached = await usableCachedAnalysis(videoId)
  if (cached) return cached

  const existing = inflight.get(videoId)
  if (existing) {
    existing.waiters += 1
    return existing.promise
  }

  const controller = new AbortController()
  const entry: InflightAnalysis = {
    controller,
    waiters: 1,
    promise: runAnalysis(
      videoId,
      lines,
      durationSeconds,
      controller.signal,
      tabId,
    ),
  }
  inflight.set(videoId, entry)
  updateKeepalive()
  try {
    return await entry.promise
  } finally {
    inflight.delete(videoId)
    updateKeepalive()
  }
}

async function runAnalysis(
  videoId: string,
  lines: TranscriptLine[],
  durationSeconds: number,
  signal: AbortSignal,
  tabId: number | undefined,
): Promise<VideoAnalysis> {
  const settings = await getSettings()
  const onProgress = (done: number, total: number) =>
    reportProgress(tabId, videoId, done, total)
  try {
    let segments
    try {
      segments = await analyzeTranscript(
        lines,
        durationSeconds,
        settings,
        signal,
        onProgress,
      )
    } catch (error) {
      // Cloud provider hit its rate limit / quota — it's now in cooldown, so a
      // retry resolves to the built-in model (re-chunked correctly for it).
      if (error instanceof RateLimitError && !signal.aborted) {
        segments = await analyzeTranscript(
          lines,
          durationSeconds,
          settings,
          signal,
          onProgress,
        )
      } else {
        throw error
      }
    }
    const analysis: VideoAnalysis = {
      videoId,
      status: 'ok',
      segments,
      // Record which provider actually produced the result (may be built-in
      // after a fallback).
      provider: resolveProvider(settings),
      analyzedAt: Date.now(),
      version: ANALYSIS_VERSION,
    }
    await setCachedAnalysis(analysis)
    return analysis
  } catch (error) {
    // Errors (including aborts) are NOT cached — a re-watch retries.
    return {
      videoId,
      status: 'error',
      reason: error instanceof Error ? error.message : String(error),
      segments: [],
      provider: resolveProvider(settings),
      analyzedAt: Date.now(),
    }
  }
}

/** Self-healing: ask the LLM for a selector when hardcoded ones break. */
async function findSelector(
  html: string,
  description: string,
): Promise<string | null> {
  const settings = await getSettings()
  if (!settings.aiEnhancements) return null
  const controller = new AbortController()
  try {
    return await findElementSelector(html, description, settings, controller.signal)
  } catch {
    return null
  }
}

/** AI consent auto-answer: find the reject/necessary-only button in a cookie banner. */
async function findConsent(html: string): Promise<string | null> {
  const settings = await getSettings()
  if (!settings.aiEnhancements) return null
  const controller = new AbortController()
  try {
    return await findConsentReject(html, settings, controller.signal)
  } catch {
    return null
  }
}

/** AI popup review: is this overlay an intrusive annoyance (hide) or functional (keep)? */
async function reviewPopupMsg(html: string): Promise<boolean> {
  const settings = await getSettings()
  if (!settings.aiEnhancements) return false
  const controller = new AbortController()
  try {
    return await reviewPopup(html, settings, controller.signal)
  } catch {
    return false // on any failure, keep the overlay (never break functionality)
  }
}

/** Gap-filler: ask the LLM for ad selectors the filter lists missed; cache them. */
async function findAds(html: string, domain: string): Promise<string[]> {
  const settings = await getSettings()
  if (!settings.aiEnhancements) return []
  const controller = new AbortController()
  try {
    const selectors = await findAdSelectors(html, settings, controller.signal)
    if (selectors.length > 0) await addGapfillSelectors(domain, selectors)
    return selectors
  } catch {
    return []
  }
}

function abandonAnalysis(videoId: string) {
  const entry = inflight.get(videoId)
  if (!entry) return
  entry.waiters -= 1
  if (entry.waiters <= 0) {
    entry.controller.abort()
    inflight.delete(videoId)
    updateKeepalive()
  }
}

// ---------------------------------------------------------------------------
// Message routing
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener(
  (message: Message, sender, sendResponse) => {
    switch (message?.type) {
      case 'skipSensei:adSkipped':
        void recordSkip('ad')
        return false
      case 'skipSensei:sponsorSkipped':
        void recordSkip('sponsor')
        return false
      case 'skipSensei:getSessionStats':
        void getSessionStats().then(sendResponse)
        return true
      case 'skipSensei:getAnalysis':
        void usableCachedAnalysis(message.videoId).then(sendResponse)
        return true
      case 'skipSensei:analyzeVideo':
        void analyzeVideo(
          message.videoId,
          message.lines,
          message.durationSeconds,
          sender.tab?.id,
        ).then(sendResponse)
        return true
      case 'skipSensei:abandonAnalysis':
        abandonAnalysis(message.videoId)
        return false
      case 'skipSensei:reportCorrection':
        void recordCorrection(message.videoId, message.start, message.end)
        return false
      case 'skipSensei:checkBuiltinAI':
        void builtinAvailability().then((availability) =>
          sendResponse({ availability }),
        )
        return true
      case 'skipSensei:getBlockerState':
        void getBlockerState().then(sendResponse)
        return true
      case 'skipSensei:tabNeedsReload':
        if (sender.tab?.id !== undefined) {
          setReloadBadge(sender.tab.id, message.needsReload)
        }
        return false
      case 'skipSensei:getTabBlocked':
        sendResponse(badgeState(message.tabId).blocked)
        return false
      case 'skipSensei:findSelector':
        void findSelector(message.html, message.description).then(sendResponse)
        return true
      case 'skipSensei:findAdSelectors':
        void findAds(message.html, message.domain).then(sendResponse)
        return true
      case 'skipSensei:reviewPopup':
        void reviewPopupMsg(message.html).then(sendResponse)
        return true
      case 'skipSensei:findConsentReject':
        void findConsent(message.html).then(sendResponse)
        return true
      default:
        return false
    }
  },
)

// Per-tab icon badge. Shows the number of ads/elements blocked on the tab; a
// "↻" takes priority when the page needs a reload to activate/apply blocking.
interface TabBadge {
  blocked: number
  needsReload: boolean
}
const tabBadges = new Map<number, TabBadge>()
const badgeState = (tabId: number): TabBadge =>
  tabBadges.get(tabId) ?? { blocked: 0, needsReload: false }

function renderBadge(tabId: number) {
  const { blocked, needsReload } = badgeState(tabId)
  const text = needsReload
    ? '↻'
    : blocked > 0
      ? blocked > 999
        ? '999+'
        : String(blocked)
      : ''
  chrome.action.setBadgeText({ tabId, text }).catch(() => {})
  if (text) {
    chrome.action
      .setBadgeBackgroundColor({ tabId, color: '#7c3aed' })
      .catch(() => {})
  }
}

function setReloadBadge(tabId: number, show: boolean) {
  const state = badgeState(tabId)
  state.needsReload = show
  tabBadges.set(tabId, state)
  renderBadge(tabId)
}

// Coalesce bursts of blocks into at most one badge update per ~400ms per tab.
const badgeRenderPending = new Set<number>()
function bumpTabBlocked(tabId: number) {
  const state = badgeState(tabId)
  state.blocked += 1
  tabBadges.set(tabId, state)
  if (badgeRenderPending.has(tabId)) return
  badgeRenderPending.add(tabId)
  setTimeout(() => {
    badgeRenderPending.delete(tabId)
    renderBadge(tabId)
  }, 400)
}

// Reset a tab's count when it navigates to a new page (block counts are per-load).
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' && changeInfo.url) {
    tabBadges.set(tabId, { blocked: 0, needsReload: false })
    renderBadge(tabId)
  }
})
chrome.tabs.onRemoved.addListener((tabId) => tabBadges.delete(tabId))

chrome.runtime.onInstalled.addListener(async (details) => {
  // First install → open the welcome page.
  if (details.reason === 'install') {
    chrome.tabs
      .create({ url: chrome.runtime.getURL('src/onboarding/index.html') })
      .catch(() => {})
  }
  // After install/update, existing YouTube tabs run stale (or no) content
  // scripts until reloaded — badge them so the user knows to refresh.
  try {
    const tabs = await chrome.tabs.query({ url: '*://*.youtube.com/*' })
    for (const tab of tabs) if (tab.id) setReloadBadge(tab.id, true)
  } catch {
    // youtube host permission missing or query failed — non-fatal
  }
})

// "Block all ads" engine: enforce DNR ruleset state; count blocks (stats + badge).
initNetBlocker(
  (n) => void recordWebBlocks(n),
  (tabId) => bumpTabBlocked(tabId),
)
