import {
  analyzeTranscript,
  auditHiddenElements,
  builtinAvailability,
  verifyAdCandidates,
  findConsentReject,
  findElementSelector,
  LlmError,
  ModelUnavailableError,
  providerFallbackChain,
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
import {
  initFilterUpdates,
  checkForUpdates,
  getFilterUpdateStatus,
} from './filter-updates'
import { initPruneRegistration, syncPruneRegistration } from './prune-register'
import {
  initCosmeticRegistration,
  syncCosmeticRegistration,
} from './cosmetic-register'
import {
  initScriptletRegistration,
  syncScriptletRegistration,
} from './scriptlet-register'
import { clearCookiesFor, clearYtVisitorCookies } from './cookies'
import { withResumeTime } from './resume'
import { initTelemetryRollup } from './telemetry-rollup'
import { isColdStart, runColdStart } from './lifecycle'
import { fetchSponsorBlockSegments } from './sponsorblock'
import {
  getInstallId,
  initErrorReporting,
  reportError,
  reportEvent,
} from './error-reporting'
import {
  clearYtBackoff,
  deleteCachedAnalysis,
  forgetResumePosition,
  getCachedAnalysis,
  getSettings,
  incrementStat,
  bumpDailyCounter,
  type DailyCounter,
  recordActivity,
  recordAdblockWall,
  recordCorrection,
  recordResumePosition,
  recordSkipTiming,
  resetStats,
  setCachedAnalysis,
  updateSettings,
  setYtBackoff,
  onSettingsChanged,
} from './storage'
import {
  ANALYSIS_VERSION,
  DEFAULT_SETTINGS,
  type BlockBreakdown,
  type LlmProvider,
  type Message,
  type ModelCatalogResult,
  type TranscriptLine,
  type VideoAnalysis,
} from './types'
import { fetchModelCatalog } from './model-catalog'

/**
 * Service worker: LLM analysis orchestration, per-videoId segment caching,
 * lifetime + daily counters.
 */

// Stat writes are serialized through this chain so concurrent recorders (e.g.
// two tabs finishing at once) can't lose an increment via interleaved
// read-modify-write on the shared stats key. incrementStat also bumps the
// matching "today" counter, so daily stats need no separate bookkeeping here.
let statChain: Promise<void> = Promise.resolve()

function recordSkip(kind: 'ad' | 'sponsor', amount = 1): Promise<void> {
  statChain = statChain
    .then(async () => {
      await incrementStat(
        kind === 'ad' ? 'allTimeAdSkips' : 'allTimeSponsorSkips',
        amount,
      )
    })
    .catch(() => {})
  return statChain
}

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
    })
    .catch(() => {})
}

/** Fold newly-hidden YouTube display ads into the YouTube card. Kept separate
 *  from ad-skips (allTimeYtAdsHidden), and safe from double-counting because
 *  YouTube has no DNR network blocking to overlap with. */
function recordYtAdsHidden(amount: number) {
  if (amount <= 0) return
  statChain = statChain
    .then(async () => {
      await incrementStat('allTimeYtAdsHidden', amount)
    })
    .catch(() => {})
}

/** Zero the lifetime AND today counters. Chained through statChain so a
 *  concurrent in-flight increment can't resurrect a count after the reset. */
function resetAllStats(): Promise<void> {
  statChain = statChain.then(() => resetStats()).catch(() => {})
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
    // Try the user's provider first, then every other saved credential (see
    // providerFallbackChain), and finally on-device AI. Advance on any
    // provider-level error — rate limit, gone model, a Custom id sent to the
    // wrong provider, an auth/network failure — so one bad key never fails an
    // analysis when another credential (or the built-in model) could do it.
    const chain = providerFallbackChain(settings)
    let segments: Awaited<ReturnType<typeof analyzeTranscript>> | undefined
    let usedSettings = settings
    let lastError: unknown
    for (let i = 0; i < chain.length; i++) {
      const candidate = chain[i]
      try {
        segments = await analyzeTranscript(
          lines,
          durationSeconds,
          candidate,
          signal,
          onProgress,
        )
        usedSettings = candidate
        if (i > 0) {
          void recordActivity(
            'Sponsor detection AI',
            `${settings.llmProvider} unavailable — analyzed with ${candidate.llmProvider} instead`,
            videoId,
          )
        }
        break
      } catch (error) {
        if (signal.aborted) throw error
        // Non-provider errors (bugs) shouldn't silently churn the whole chain.
        if (!(error instanceof LlmError)) throw error
        lastError = error
      }
    }
    if (segments === undefined) {
      throw lastError instanceof Error
        ? lastError
        : new LlmError('All providers failed')
    }
    const analysis: VideoAnalysis = {
      videoId,
      status: 'ok',
      segments,
      // The provider that actually produced the result (may be a fallback).
      provider: usedSettings.llmProvider,
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
    // Rate limits and gone-model errors are expected operating conditions that
    // the fallbacks above handle when possible — not defects worth reporting.
    if (
      !signal.aborted &&
      !(error instanceof RateLimitError) &&
      !(error instanceof ModelUnavailableError)
    ) {
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

const MODEL_CATALOG_KEY = 'skipSensei.modelCatalog'

/**
 * On-demand "Refresh models": fetch the provider's live model list and cache it
 * under skipSensei.modelCatalog.<provider>. Fails soft — on error the options
 * page keeps whatever curated/cached list it already shows.
 */
async function refreshModelCatalog(
  provider: LlmProvider,
): Promise<ModelCatalogResult> {
  const settings = await getSettings()
  if (settings.localOnlyMode) {
    return { provider, models: [], fetchedAt: null, error: 'Local-only mode is on' }
  }
  try {
    const models = await fetchModelCatalog(provider, settings)
    const result: ModelCatalogResult = {
      provider,
      models,
      fetchedAt: Date.now(),
      error: null,
    }
    await chrome.storage.local.set({ [`${MODEL_CATALOG_KEY}.${provider}`]: result })
    return result
  } catch (error) {
    return {
      provider,
      models: [],
      fetchedAt: null,
      error: error instanceof Error ? error.message.slice(0, 160) : 'fetch failed',
    }
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

/**
 * UI-usage counters, routed here so the ONE storage chain (this context's)
 * serializes all writers — the popup's and options page's own module
 * instances would race it otherwise. Names are validated against a closed
 * set: fixed counters, or `uiSet_<key>` for a real Settings key. Anything
 * else is dropped, so the message surface can't be used to pollute rollups.
 */
const UI_USAGE_COUNTERS = new Set([
  'uiPopupOpens',
  'uiControlsTab',
  'uiOptionsOpens',
  'uiSitePauses',
  'uiShares',
  'uiReviews',
])

function bumpUiUsage(counter: string): void {
  if (UI_USAGE_COUNTERS.has(counter)) {
    void bumpDailyCounter(counter as DailyCounter)
    return
  }
  if (counter.startsWith('uiSet_')) {
    const key = counter.slice('uiSet_'.length)
    if (key in DEFAULT_SETTINGS) void bumpDailyCounter(counter as DailyCounter)
  }
}

/** AI popup review: is this overlay an intrusive annoyance (hide) or functional (keep)? */
async function reviewPopupMsg(
  html: string,
  text: string,
  host?: string,
  desc?: string,
): Promise<boolean> {
  const settings = await getSettings()
  if (!settings.aiEnhancements) return false
  const controller = new AbortController()
  try {
    const { hide, summary } = await reviewPopup(html, text, settings, controller.signal)
    // Prefer the AI's content summary ("Newsletter signup…"); fall back to the
    // content script's structural label (tag + size) if the model gave none.
    const content = summary || desc || ''
    const detail = content ? ` — ${content}` : ''
    void recordActivity(
      'Block popup & overlay ads',
      hide
        ? `reviewed a popup, hid it (intrusive)${detail}`
        : `reviewed a popup, kept it (looks functional)${detail}`,
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
 * unsure, no"). Returns confirmed candidate indexes.
 *
 * Failures (LLM outage, bad key, quota, feature raced off) return NULL — "no
 * verdict, ask again later" — never []. The content script caches [] as a
 * real answer ("all candidates vetoed" / "domain scanned"), so conflating the
 * two turned one transient error into a permanent no-retry state.
 */
async function verifyCandidates(
  candidates: Array<{ index: number; html: string; text?: string }>,
  page?: { host: string; title: string },
): Promise<number[] | null> {
  const settings = await getSettings()
  if (!settings.aiEnhancements) return null
  const controller = new AbortController()
  try {
    return await verifyAdCandidates(candidates, page, settings, controller.signal)
  } catch {
    return null // no verdict — the content script retries on a later visit
  }
}

/** AI audit of list-driven hides: which of these hidden elements are CLEARLY
 * not ads? Failures return NULL (no verdict, retry later), never [] — a []
 * would be cached as a definitive 'ad' verdict per selector and permanently
 * skip re-auditing, so one LLM hiccup would disable the rescue for good.
 * Everything stays hidden while there's no verdict, so fail direction holds. */
async function auditHidden(
  candidates: Array<{ index: number; html: string; text?: string }>,
  page?: { host: string; title: string },
): Promise<number[] | null> {
  const settings = await getSettings()
  if (!settings.aiEnhancements) return null
  const controller = new AbortController()
  try {
    return await auditHiddenElements(candidates, page, settings, controller.signal)
  } catch {
    return null
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

/**
 * Aggressive-pruning circuit breaker. One enforcement wall is enough to back
 * off: YouTube can flag the signed-in session on the FIRST wall, so waiting
 * for more only prolongs the exposure. Reactive skipping keeps working.
 *
 * This lives in the service worker, not the content script, because it is a
 * decision — and there must be exactly one of them. Every engine instance used
 * to make it independently, so two watch tabs (or an SPA navigation rebuilding
 * the engine) would each read `aggressivePruning` as still true, each write it
 * false, and each log; the activity log showed two "auto-disabled" entries
 * inside the same second and the wall counts were inflated accordingly.
 */
const WALL_DEDUPE_MS = 10_000

/** Serialize wall reports: two tabs showing the same enforcement wall deliver
 * two messages, and the storage dedupe below is read-then-write across an
 * await — unserialized, both passed the 10s gate and double-counted. Single
 * decision-maker (this file) AND single flight (this chain). */
let wallChain: Promise<void> = Promise.resolve()

function queueWallSeen(walls: number, tabId?: number): Promise<void> {
  wallChain = wallChain
    .then(() => handleWallSeen(walls, tabId))
    .catch(() => {})
  return wallChain
}

async function handleWallSeen(walls: number, tabId?: number) {
  const last =
    (await chrome.storage.session.get('lastWallAt')).lastWallAt ?? 0
  const now = Date.now()
  // Reports from several tabs about the same enforcement event collapse into
  // one. A genuinely new wall is always more than a few seconds later — it
  // takes a reload to get there.
  if (now - last < WALL_DEDUPE_MS) return
  await chrome.storage.session.set({ lastWallAt: now })

  // The popup notice must show even when pruning was already off, so the
  // backoff flag is recorded regardless of whether the breaker has anything
  // left to disable.
  void bumpDailyCounter('walls')
  // A wall on a tab that just tried the visitor-only clear means that clear
  // did not lift it. Counting failures rather than successes avoids needing a
  // per-tab timer to decide when "no wall yet" has become "it worked" —
  // successes fall out as tried minus failed in the rollup.
  if (tabId !== undefined) {
    const key = `ytVisitorClear.${tabId}`
    const at = (await chrome.storage.session.get(key))[key] ?? 0
    if (at && Date.now() - at < 5 * 60_000) {
      void bumpDailyCounter('visitorClearFailed')
    }
  }
  await setYtBackoff(walls)
  void recordActivity(
    'Skip YouTube ads',
    'YouTube blocked playback for this session — offered the cookie-clear fix',
    'youtube.com',
  )
  void reportEvent('yt_hard_block', { walls: String(walls) })

  if (!(await getSettings()).aggressivePruning) return
  void bumpDailyCounter('breakerTrips')
  await updateSettings({ aggressivePruning: false })
  void recordActivity(
    'First-party ad blocking',
    'YouTube flagged the session — first-party ad blocking auto-disabled (reactive skipping still on)',
    'youtube.com',
  )
  // Detection signal: how often aggressive pruning gets caught in the wild
  // tells us whether it's worth keeping / how to harden it.
  void reportEvent('aggressive_breaker', { walls: String(walls) })
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
  pruned: 'blocked an ad before it could load',
  'overlay-removed': 'removed an overlay ad',
  'pause-overlay-dismissed': 'dismissed a pause-screen ad',
}

chrome.runtime.onMessage.addListener(
  (message: Message, sender, sendResponse) => {
    switch (message?.type) {
      case 'skipSensei:adSkipped': {
        const count = message.count && message.count > 0 ? message.count : 1
        void recordSkip('ad', count)
        // quiet = the ad engine already wrote its aggregated per-break line.
        if (message.quiet) return false
        // The first-party layer (json-prune) blocks ads before they load — a
        // distinct feature/tier from reactive skipping, and logged as such so
        // the activity log mirrors the reframed setting names.
        if (message.method === 'pruned') {
          const desc =
            count > 1
              ? `blocked ${count} ads before they could load`
              : 'blocked an ad before it could load'
          void recordActivity(
            "Block YouTube's first-party ads",
            desc,
            senderHost(sender),
          )
          return false
        }
        const desc = AD_SKIP_DESCRIPTIONS[message.method] ?? 'neutralized an ad'
        void recordActivity('Skip YouTube ads', desc, senderHost(sender))
        return false
      }
      case 'skipSensei:event':
        // Rates need a denominator the per-event stream can't provide (it
        // dedupes identical payloads within the hour), so count locally too.
        if (message.kind === 'self_heal') void bumpDailyCounter('selfHeals')
        if (message.kind === 'skip_failed') void bumpDailyCounter('skipFailures')
        if (
          message.kind === 'gapfill_feedback' &&
          message.fields?.verdict === 'not-ad'
        ) {
          // The user un-hid something we hid: a false positive, and the
          // earliest warning that a heuristic has gone wrong on a live site.
          void bumpDailyCounter('cosmeticUnhides')
        }
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
      case 'skipSensei:clearVideoAnalysis':
        void deleteCachedAnalysis(message.videoId).then(() => sendResponse(true))
        return true
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
      case 'skipSensei:uiUsage':
        bumpUiUsage(message.counter)
        return false
      // Storage writers routed here from content scripts so ONE chain (this
      // context's) serializes them — each tab's own module instance would
      // otherwise read-modify-write the shared keys against every other tab.
      case 'skipSensei:skipTiming':
        void recordSkipTiming({ s: message.s, m: message.m, ads: message.ads })
        return false
      case 'skipSensei:resumeSave':
        void recordResumePosition(message.videoId, message.seconds)
        return false
      case 'skipSensei:resumeForget':
        void forgetResumePosition(message.videoId)
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
      case 'skipSensei:checkFilterUpdates':
        void checkForUpdates(true).then(sendResponse)
        return true
      case 'skipSensei:getFilterUpdateStatus':
        void getFilterUpdateStatus().then(sendResponse)
        return true
      case 'skipSensei:refreshModels':
        void refreshModelCatalog(message.provider).then(sendResponse)
        return true
      case 'skipSensei:adblockWall':
        void recordAdblockWall(message.hostname)
        return false
      case 'skipSensei:clearYtCookies':
        // The in-player recovery panel's action: clear youtube.com cookies to
        // lift YouTube's ad-blocker-detection flag (same remedy as the popup
        // button), drop the backoff notice, and reload the blocked tab.
        // Respond BEFORE reloading — the reload destroys the sender's context.
        void (async () => {
          try {
            const visitorOnly = message.scope === 'visitor'
            void bumpDailyCounter(
              visitorOnly ? 'visitorClearTried' : 'fullClears',
            )
            const cleared = visitorOnly
              ? await clearYtVisitorCookies()
              : await clearCookiesFor({ domain: 'youtube.com' })
            await clearYtBackoff()
            // Remember a stage-one attempt so the panel can escalate if the
            // wall survives the reload. Tab-scoped and short-lived: a wall an
            // hour later is a fresh problem, not a failed visitor clear.
            if (sender.tab?.id !== undefined) {
              await chrome.storage.session.set({
                [`ytVisitorClear.${sender.tab.id}`]: visitorOnly
                  ? Date.now()
                  : 0,
              })
            }
            void recordActivity(
              'Skip YouTube ads',
              visitorOnly
                ? `Cleared ${cleared} YouTube visitor cookie(s), kept the sign-in — testing whether the wall lifts`
                : `Cleared all ${cleared} youtube.com cookie(s) — signs the user out`,
              'youtube.com',
            )
            sendResponse({ ok: true })
            if (sender.tab?.id !== undefined) {
              // Clearing cookies also wipes YouTube's own resume state, so a
              // plain reload restarts the video at 0:00. Navigate to the same
              // watch URL with `t=` instead when the engine saw real playback;
              // withResumeTime returns null when there's nothing to restore.
              const resumeUrl = withResumeTime(
                sender.tab.url ?? '',
                message.resumeSeconds ?? 0,
              )
              if (resumeUrl) {
                await chrome.tabs.update(sender.tab.id, { url: resumeUrl })
              } else {
                await chrome.tabs.reload(sender.tab.id)
              }
            }
          } catch {
            sendResponse({ ok: false })
          }
        })()
        return true
      case 'skipSensei:wallSeen':
        void queueWallSeen(message.walls, sender.tab?.id)
        return false
      case 'skipSensei:getWallState':
        void (async () => {
          const id = sender.tab?.id
          if (id === undefined) return sendResponse({ triedVisitorClear: false })
          const key = `ytVisitorClear.${id}`
          const at = (await chrome.storage.session.get(key))[key] ?? 0
          // Five minutes covers the clear + reload + player boot with room to
          // spare, without a stale marker mislabelling a later wall.
          sendResponse({ triedVisitorClear: Date.now() - at < 5 * 60_000 })
        })()
        return true
      case 'skipSensei:tabNeedsReload':
        if (sender.tab?.id !== undefined) {
          setReloadBadge(sender.tab.id, message.needsReload)
        }
        return false
      case 'skipSensei:getTabBlocked':
        // "Blocked here" = hidden ad slots + non-ad DNR network blocks. The
        // network side is a live recount on popup open (a user gesture →
        // generally quota-exempt), so it reflects ads that loaded after the
        // page finished; it also refreshes the stored network count. The
        // cosmetic side is the content script's live tally. Falls back to the
        // last stored network count if the live query is throttled.
        void getTabBlockCounts(message.tabId).then((counts) => {
          if (counts) setTabBlocked(message.tabId, counts)
          sendResponse(tabBreakdown(message.tabId))
        })
        return true
      case 'skipSensei:cosmeticHideCount':
        if (sender.tab?.id !== undefined) {
          // One ad = one hidden topmost slot, empty or filled. A slot is the
          // page's declared intent to show one ad — the closest countable
          // thing to "an ad you would have seen". Blocked ad REQUESTS are
          // never added on top: one blocked library (gpt.js) empties every
          // slot on the page, and one rendered ad fires dozens of bid/beacon
          // requests, so requests can't be the ad unit in either direction.
          // YouTube slots go to the YouTube card instead of web-ads.
          const onYouTube = Boolean(sender.tab.url?.includes('youtube.com'))
          setTabCosmetic(sender.tab.id, message.count)
          if (onYouTube) recordYtAdsHidden(message.added)
          else if (message.added > 0)
            recordBlockCounts({
              ads: message.added,
              trackers: 0,
              cookies: 0,
            })
        }
        return false
      case 'skipSensei:findSelector':
        void findSelector(message.html, message.description).then(sendResponse)
        return true
      case 'skipSensei:verifyAdCandidates':
        void verifyCandidates(message.candidates, message.page).then(sendResponse)
        return true
      case 'skipSensei:auditHiddenElements':
        void auditHidden(message.candidates, message.page).then(sendResponse)
        return true
      case 'skipSensei:reviewPopup':
        void reviewPopupMsg(
          message.html,
          message.text ?? '',
          senderHost(sender),
          message.desc,
        ).then(sendResponse)
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
// (getMatchedRules, event-cadence) and hidden ad slots (topmost, deduped —
// reported live by the content script). A "↻" takes priority when the page
// needs a reload.
const emptyBreakdown = (): BlockBreakdown => ({
  ads: 0,
  trackers: 0,
  cookies: 0,
  social: 0,
  popups: 0,
  links: 0,
  malware: 0,
})
const sumBreakdown = (b: BlockBreakdown): number =>
  b.ads + b.trackers + b.cookies + b.social + b.popups + b.links + b.malware

interface TabBadge {
  /** DNR network blocks by type — set by the block counter. */
  network: BlockBreakdown
  /** Hidden topmost ad slots from the content script's live tally — the ad
   *  count (one slot ≈ one ad). Empty and filled alike: an empty slot's ad
   *  was stopped upstream, but it's still one ad the user didn't see. */
  cosmetic: number
  needsReload: boolean
}
const tabBadges = new Map<number, TabBadge>()
const freshBadge = (): TabBadge => ({
  network: emptyBreakdown(),
  cosmetic: 0,
  needsReload: false,
})
const badgeState = (tabId: number): TabBadge =>
  tabBadges.get(tabId) ?? freshBadge()

/** Per-type snapshot for the popup breakdown. `ads` = hidden topmost slots
 *  (one slot ≈ one ad you'd have seen). Blocked ad requests only stand in
 *  when the page had NO hideable slots at all — some ads are fought off with
 *  no container to hide, and "0 ads" would be wrong there. Never both. */
const tabBreakdown = (tabId: number): BlockBreakdown => {
  const s = badgeState(tabId)
  return { ...s.network, ads: s.cosmetic > 0 ? s.cosmetic : s.network.ads }
}

/** Total shown on the badge / "blocked here": sum of the displayed breakdown,
 *  so the badge and the popup line can never disagree. */
const tabBlockedTotal = (tabId: number): number =>
  sumBreakdown(tabBreakdown(tabId))

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
function setTabBlocked(tabId: number, breakdown: BlockBreakdown) {
  const state = badgeState(tabId)
  if (sumBreakdown(state.network) === sumBreakdown(breakdown)) return
  state.network = breakdown
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
    tabBadges.set(tabId, freshBadge())
    renderBadge(tabId)
  }
})
chrome.tabs.onRemoved.addListener((tabId) => tabBadges.delete(tabId))

chrome.runtime.onInstalled.addListener(async (details) => {
  // First install → open the welcome page.
  if (details.reason === 'install') {
    chrome.tabs
      .create({ url: chrome.runtime.getURL('onboarding.html') })
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
  // Lifetime "web ads" counts hidden slots (see cosmeticHideCount above);
  // blocked ad REQUESTS never increment it — one library block hides many
  // ads, one ad fires many requests. Trackers/cookies stay request-based:
  // there each blocked request genuinely is one tracking attempt.
  onCounts: (c) => recordBlockCounts({ ...c, ads: 0 }),
  onTabCount: (tabId, breakdown) => setTabBlocked(tabId, breakdown),
})

// Aggressive-mode YouTube pruner: (un)register the MAIN-world content script
// to match the aggressivePruning setting.
initPruneRegistration()

// Anti-adblock scriptlet layer: (un)register the MAIN-world scriptlet bundle
// for the broad web (dormant until broad host permission is granted).
initScriptletRegistration()

// Broad-web cosmetic filtering: (un)register the cosmetic content script for
// *://*/* (dormant until a web-cosmetic feature is on AND the optional
// all-sites host permission is granted). YouTube is covered statically.
initCosmeticRegistration()

// Differential filter-list updates: periodic + cold-start check for refreshed
// cosmetic-shard DATA (self-throttling; gated on filterUpdatesEnabled).
initFilterUpdates()

// One aggregate telemetry event per day (distributions + counters). Alarm-
// driven so service-worker dormancy can't skip it; self-throttling per day.
initTelemetryRollup()

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
      await syncCosmeticRegistration()
    })
  } else {
    await verifyNetBlocker()
  }
})()

// Sanitized crash reporting for anything nobody caught (usage analytics come
// from Chrome Web Store stats, not from the extension).
initErrorReporting()

// Post-uninstall goodbye page (reinstall CTA + optional exit survey). Consent-
// gated, not a tracker: the URL carries the version and the same random
// install id ONLY while the diagnostics toggle is on; with diagnostics off or
// Local-only mode on, the URL is cleared and no page opens on uninstall —
// disclosed in the privacy policy (§3). Re-synced on every settings change so
// flipping the toggle takes effect immediately.
const GOODBYE_URL = 'https://www.singlefinmedia.com/ad-sensei/goodbye'
async function syncUninstallUrl(): Promise<void> {
  const settings = await getSettings()
  const url =
    settings.telemetryEnabled && !settings.localOnlyMode
      ? `${GOODBYE_URL}?v=${chrome.runtime.getManifest().version}&iid=${await getInstallId()}`
      : ''
  await chrome.runtime.setUninstallURL(url)
}
void syncUninstallUrl().catch(() => {})
onSettingsChanged(() => void syncUninstallUrl().catch(() => {}))
