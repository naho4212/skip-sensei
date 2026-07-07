import { analyzeTranscript, builtinAvailability, resolveProvider } from './llm-client'
import {
  getCachedAnalysis,
  getSettings,
  incrementStat,
  recordCorrection,
  setCachedAnalysis,
} from './storage'
import type {
  Message,
  SessionStats,
  TranscriptLine,
  VideoAnalysis,
} from './types'

/**
 * Service worker: LLM analysis orchestration, per-videoId segment caching,
 * session counters.
 */

const SESSION_STATS_KEY = 'skipSensei.sessionStats'

const EMPTY_SESSION: SessionStats = {
  sessionAdSkips: 0,
  sessionSponsorSkips: 0,
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
  const provider = resolveProvider(settings)
  try {
    const segments = await analyzeTranscript(
      lines,
      durationSeconds,
      settings,
      signal,
      (done, total) => reportProgress(tabId, videoId, done, total),
    )
    const analysis: VideoAnalysis = {
      videoId,
      status: 'ok',
      segments,
      provider,
      analyzedAt: Date.now(),
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
      provider,
      analyzedAt: Date.now(),
    }
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
      default:
        return false
    }
  },
)
