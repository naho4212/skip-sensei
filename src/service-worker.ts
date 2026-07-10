import {
  analyzeTranscript,
  builtinAvailability,
  verifyAdCandidates,
  findConsentReject,
  findElementSelector,
  RateLimitError,
  resolveProvider,
  reviewPopup,
} from './llm-client'
import {
  getBlockerState,
  getRulesetInfo,
  getTabBlockCounts,
  initNetBlocker,
  syncNetBlocker,
  verifyNetBlocker,
} from './net-blocker'
import { getCosmeticFilters } from './cosmetic-filters'
import { initPruneRegistration, syncPruneRegistration } from './prune-register'
import {
  initScriptletRegistration,
  syncScriptletRegistration,
} from './scriptlet-register'
import { isColdStart, runColdStart } from './lifecycle'
import { fetchSponsorBlockSegments } from './sponsorblock'
import { initErrorReporting, reportError, reportEvent } from './error-reporting'
import {
  getCachedAnalysis,
  getSettings,
  incrementStat,
  recordActivity,
  recordCorrection,
  resetStats,
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
  sessionTrackersBlocked: 0,
  sessionCookiesBlocked: 0,
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

// Stat writes are serialized through this chain so concurrent polls (e.g. two
// tabs finishing at once) can't lose an increment via interleaved
// read-modify-write on the shared stats / session keys.
let statChain: Promise<void> = Promise.resolve()

function recordBlockCounts(c: {
  ads: number
  trackers: number
  cookies: number
}) {
  statChain = statChain
    .then(async () => {
      if (c.ads) await incrementStat('allTimeWebAdsBlocked', c.ads)
      if (c.trackers) await incrementStat('allTimeTrackersBlocked', c.trackers)
      if (c.cookies) await incrementStat('allTimeCookiesBlocked', c.cookies)
      const session = await getSessionStats()
      session.sessionWebAdsBlocked += c.ads
      session.sessionTrackersBlocked += c.trackers
      session.sessionCookiesBlocked += c.cookies
      await chrome.storage.session.set({ [SESSION_STATS_KEY]: session })
    })
    .catch(() => {})
}

/** Zero the lifetime AND session counters. Chained through statChain so a
 *  concurrent in-flight increment can't resurrect a count after the reset. */
function resetAllStats(): Promise<void> {
  statChain = statChain
    .then(async () => {
      await resetStats()
      await chrome.storage.session.set({ [SESSION_STATS_KEY]: EMPTY_SESSION })
    })
    .catch(() => {})
  return statChain
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
    void recordActivity(
      'Sponsor detection AI',
      `analyzed a video — ${segments.length} sponsor segment(s) found (${analysis.provider})`,
      videoId,
    )
    return analysis
  } catch (error) {
    // Rate limits are expected operating conditions, not defects.
    if (!signal.aborted && !(error instanceof RateLimitError)) {
      void reportError('analyze-video', error)
    }
    if (!signal.aborted) {
      void recordActivity(
        'Sponsor detection AI',
        `analysis failed — ${error instanceof Error ? error.message.slice(0, 120) : 'unknown error'}`,
        videoId,
      )
    }
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
    const selector = await findElementSelector(
      html,
      description,
      settings,
      controller.signal,
    )
    // NOTE: we deliberately do NOT log or report the heal here. This is the
    // AI's *proposed* selector; the content script validates it before use
    // and, only if it passes, writes the activity-log entry and fires the
    // self_heal telemetry (see AdEngine.recordHeal). That keeps both signals
    // to confirmed-working selectors.
    return selector
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
async function reviewPopupMsg(html: string, host?: string): Promise<boolean> {
  const settings = await getSettings()
  if (!settings.aiEnhancements) return false
  const controller = new AbortController()
  try {
    const hide = await reviewPopup(html, settings, controller.signal)
    void recordActivity(
      'Block popup & overlay ads',
      hide
        ? 'reviewed a popup — hid it (intrusive)'
        : 'reviewed a popup — kept it (looks functional)',
      host,
    )
    return hide
  } catch {
    return false // on any failure, keep the overlay (never break functionality)
  }
}

/**
 * Gap-filler v2: the content script finds ad candidates deterministically and
 * generates the selectors itself; the AI only vetoes ("is this an ad? when
 * unsure, no"). Returns confirmed candidate indexes; [] on any failure, so
 * failure means an ad might show — never that real UI gets hidden.
 */
async function verifyCandidates(
  candidates: Array<{ index: number; html: string }>,
): Promise<number[]> {
  const settings = await getSettings()
  if (!settings.aiEnhancements) return []
  const controller = new AbortController()
  try {
    return await verifyAdCandidates(candidates, settings, controller.signal)
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

/** Hostname of the tab a message came from, for the activity log. */
const senderHost = (sender: chrome.runtime.MessageSender): string | undefined =>
  sender.tab?.url ? new URL(sender.tab.url).hostname.replace(/^www\./, '') : undefined

const AD_SKIP_DESCRIPTIONS: Record<string, string> = {
  'skip-button': 'clicked the Skip button on an ad',
  'fast-forward': 'fast-forwarded an unskippable ad',
  'stuck-recovery': 'recovered a stuck ad player',
  pruned: 'blocked ads before they could load (aggressive)',
  'overlay-removed': 'removed an overlay ad',
  'pause-overlay-dismissed': 'dismissed a pause-screen ad',
}

chrome.runtime.onMessage.addListener(
  (message: Message, sender, sendResponse) => {
    switch (message?.type) {
      case 'skipSensei:adSkipped':
        void recordSkip('ad')
        void recordActivity(
          'Skip YouTube ads',
          AD_SKIP_DESCRIPTIONS[message.method] ?? 'neutralized an ad',
          senderHost(sender),
        )
        return false
      case 'skipSensei:event':
        void reportEvent(message.kind, {
          ...(message.fields ?? {}),
          host: senderHost(sender) ?? '',
        })
        return false
      case 'skipSensei:sponsorSkipped':
        void recordSkip('sponsor')
        void recordActivity(
          'Skip sponsor segments',
          'skipped a sponsor segment',
          message.videoId,
        )
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
        void recordActivity(
          'Corrections',
          `you flagged a wrong skip (${Math.round(message.start)}s–${Math.round(message.end)}s)`,
          message.videoId,
        )
        return false
      case 'skipSensei:logActivity':
        void recordActivity(message.feature, message.action, senderHost(sender))
        return false
      case 'skipSensei:checkBuiltinAI':
        void builtinAvailability().then((availability) =>
          sendResponse({ availability }),
        )
        return true
      case 'skipSensei:getBlockerState':
        void getBlockerState().then(sendResponse)
        return true
      case 'skipSensei:getRulesetInfo':
        void getRulesetInfo().then(sendResponse)
        return true
      case 'skipSensei:resetStats':
        void resetAllStats().then(() => sendResponse({ ok: true }))
        return true
      case 'skipSensei:getCosmeticFilters':
        void getCosmeticFilters(message.hostname).then(sendResponse)
        return true
      case 'skipSensei:tabNeedsReload':
        if (sender.tab?.id !== undefined) {
          setReloadBadge(sender.tab.id, message.needsReload)
        }
        return false
      case 'skipSensei:getTabBlocked':
        // "Blocked here" = DNR network blocks + cosmetic hides. The network
        // side is a live recount on popup open (a user gesture → generally
        // quota-exempt), so it reflects ads that loaded after the page
        // finished; it also refreshes the stored network count. The cosmetic
        // side is the content script's live tally. Falls back to the last
        // stored network count if the live query is throttled.
        void getTabBlockCounts(message.tabId).then((counts) => {
          if (counts) setTabBlocked(message.tabId, counts.ads + counts.trackers)
          sendResponse(tabBlockedTotal(message.tabId))
        })
        return true
      case 'skipSensei:cosmeticHideCount':
        if (sender.tab?.id !== undefined) {
          setTabCosmetic(sender.tab.id, message.count)
        }
        return false
      case 'skipSensei:findSelector':
        void findSelector(message.html, message.description).then(sendResponse)
        return true
      case 'skipSensei:verifyAdCandidates':
        void verifyCandidates(message.candidates).then(sendResponse)
        return true
      case 'skipSensei:reviewPopup':
        void reviewPopupMsg(message.html, senderHost(sender)).then(sendResponse)
        return true
      case 'skipSensei:findConsentReject':
        void findConsent(message.html).then(sendResponse)
        return true
      case 'skipSensei:fetchSponsorBlock':
        void (async () => {
          const settings = await getSettings()
          if (
            !settings.sponsorBlockEnabled ||
            settings.localOnlyMode ||
            settings.sponsorBlockCategories.length === 0
          ) {
            sendResponse([])
            return
          }
          sendResponse(
            await fetchSponsorBlockSegments(
              message.videoId,
              settings.sponsorBlockCategories,
            ),
          )
        })()
        return true
      default:
        return false
    }
  },
)

// Per-tab icon badge. The count is the sum of two sources: DNR network blocks
// (getMatchedRules, event-cadence) and cosmetic element hides (reported live by
// the content script). A "↻" takes priority when the page needs a reload.
interface TabBadge {
  /** DNR network blocks (ads + trackers) — set by the block counter. */
  network: number
  /** Ad elements hidden by the content script — reported live per page. */
  cosmetic: number
  needsReload: boolean
}
const tabBadges = new Map<number, TabBadge>()
const badgeState = (tabId: number): TabBadge =>
  tabBadges.get(tabId) ?? { network: 0, cosmetic: 0, needsReload: false }

/** Total shown on the badge / "blocked here": network blocks + hidden ads. */
const tabBlockedTotal = (tabId: number): number => {
  const s = badgeState(tabId)
  return s.network + s.cosmetic
}

function renderBadge(tabId: number) {
  const { needsReload } = badgeState(tabId)
  const blocked = tabBlockedTotal(tabId)
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

// Set the tab's DNR network count to the current page snapshot (net-blocker
// recounts the whole page each poll, so this is a set, not an increment —
// re-polling can correct the number up but never double-counts it).
function setTabBlocked(tabId: number, count: number) {
  const state = badgeState(tabId)
  if (state.network === count) return
  state.network = count
  tabBadges.set(tabId, state)
  renderBadge(tabId)
}

// Set the tab's cosmetic-hide count from the content script's live tally (also
// a monotonic snapshot, so setting is safe — no double-count on re-report).
function setTabCosmetic(tabId: number, count: number) {
  const state = badgeState(tabId)
  if (state.cosmetic === count) return
  state.cosmetic = count
  tabBadges.set(tabId, state)
  renderBadge(tabId)
}

// Reset a tab's count when it navigates to a new page (block counts are per-load).
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' && changeInfo.url) {
    tabBadges.set(tabId, { network: 0, cosmetic: 0, needsReload: false })
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

// One-time amnesty for saved "not an ad" ratings. Every rating collected
// before Jul 9 2026 came from unlabeled 👍/👎 buttons that users read as
// "rate the ad" — so ads got 👎'd, which un-hid them and silently disabled
// whole features per-site (.skip-sensei-empty-slot in a rejected list kills
// the slot collapser for the domain). The buttons are labeled now and the
// popup has an Undo row; wipe the poisoned store once and let clean ratings
// accumulate.
const REJECTED_AMNESTY_FLAG = 'skipSensei.rejectedAmnestyV1'
void (async () => {
  const got = await chrome.storage.local.get(REJECTED_AMNESTY_FLAG)
  if (got[REJECTED_AMNESTY_FLAG]) return
  await chrome.storage.local.remove('skipSensei.gapfillRejected')
  await chrome.storage.local.set({ [REJECTED_AMNESTY_FLAG]: true })
})()

// "Block all ads" engine: enforce DNR ruleset state; count blocks (stats + badge).
initNetBlocker({
  onCounts: (c) => recordBlockCounts(c),
  onTabCount: (tabId, count) => setTabBlocked(tabId, count),
})

// Aggressive-mode YouTube pruner: (un)register the MAIN-world content script
// to match the aggressivePruning setting.
initPruneRegistration()

// Anti-adblock scriptlet layer: (un)register the MAIN-world scriptlet bundle
// for the broad web (dormant until broad host permission is granted).
initScriptletRegistration()

// Cold-start gate: DNR ruleset state and chrome.scripting registrations persist
// across service-worker restarts, so we only run the full sync on a genuine
// cold start (browser launch / install / update) — not on every idle wake.
// (onInstalled/onStartup/onSettingsChanged still re-sync on their own events.)
// Warm wakes get the cheap drift check instead. Enabled-ruleset state lives
// in Chrome and outlives the worker, so if it ever stops matching settings
// (an earlier sync that failed, an extension reload) nothing would notice
// until the next settings change; the check re-syncs only when they disagree.
void (async () => {
  if (await isColdStart()) {
    await runColdStart(async () => {
      await syncNetBlocker()
      await syncPruneRegistration()
      await syncScriptletRegistration()
    })
  } else {
    await verifyNetBlocker()
  }
})()

// Sanitized crash reporting for anything nobody caught (usage analytics come
// from Chrome Web Store stats, not from the extension).
initErrorReporting()
