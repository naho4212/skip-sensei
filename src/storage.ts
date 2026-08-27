import {
  DEFAULT_SETTINGS,
  DEFAULT_STATS,
  EMPTY_TODAY,
  type ApiUsage,
  type LifetimeStatKey,
  type LlmProvider,
  type Settings,
  type Stats,
  type TodayStats,
  type VideoAnalysis,
} from './types'

const SETTINGS_KEY = 'skipSensei.settings'
const STATS_KEY = 'skipSensei.stats'
const USAGE_KEY = 'skipSensei.apiUsage'
const CACHE_PREFIX = 'skipSensei.cache.'
const CACHE_INDEX_KEY = 'skipSensei.cacheIndex'
const CORRECTIONS_KEY = 'skipSensei.corrections'
const SETTINGS_LOG_KEY = 'skipSensei.settingsLog'
const LAST_SEEN_VERSION_KEY = 'skipSensei.lastSeenVersion'

/** Most recent videoIds kept in the analysis cache. */
const CACHE_MAX_ENTRIES = 200
const CORRECTIONS_MAX_ENTRIES = 200

/**
 * Serialize read-modify-write storage ops so concurrent writers in the SAME
 * JS context can't interleave (both read → both write → one write lost).
 *
 * THE LIMIT, learned the hard way: every extension context — the service
 * worker, each tab's content script, the popup — evaluates its own copy of
 * this module, so each gets its own chain. A chain therefore only serializes
 * writers that all run in ONE context. Writers reachable from several
 * contexts (content scripts in N tabs) must be routed through the service
 * worker via a message; the chain then lives where all the writes are.
 */
function makeChain(): (task: () => Promise<void>) => Promise<void> {
  let tail: Promise<void> = Promise.resolve()
  return (task) => {
    tail = tail.then(task).catch(() => {})
    return tail
  }
}

export async function getSettings(): Promise<Settings> {
  const result = await chrome.storage.local.get(SETTINGS_KEY)
  return { ...DEFAULT_SETTINGS, ...(result[SETTINGS_KEY] ?? {}) }
}

export async function updateSettings(
  patch: Partial<Settings>,
): Promise<Settings> {
  const current = await getSettings()
  const next = { ...current, ...patch }
  await chrome.storage.local.set({ [SETTINGS_KEY]: next })
  void appendSettingsLog(diffSettings(current, patch))
  return next
}

// ---------------------------------------------------------------------------
// Settings change history — every option toggle/edit, newest last. API keys
// are never stored in the log (redacted to set/cleared).
// ---------------------------------------------------------------------------

export interface SettingsLogEntry {
  at: number
  /** Settings key, or dotted sub-key like "apiKeys.gemini". */
  key: string
  from: string
  to: string
}

const SETTINGS_LOG_MAX = 500

/** Render a settings value for the log (display-safe, short). */
function logValue(value: unknown): string {
  if (value === undefined || value === null || value === '') return '(default)'
  if (typeof value === 'boolean') return value ? 'on' : 'off'
  if (Array.isArray(value)) return value.length === 0 ? '(none)' : value.join(', ')
  return String(value)
}

function diffSettings(
  current: Settings,
  patch: Partial<Settings>,
): SettingsLogEntry[] {
  const at = Date.now()
  const entries: SettingsLogEntry[] = []
  for (const key of Object.keys(patch) as (keyof Settings)[]) {
    if (key === 'apiKeys') {
      // Redact: record only that a key was set or cleared, never the value.
      const before = current.apiKeys
      const after = patch.apiKeys ?? {}
      for (const provider of new Set([
        ...Object.keys(before),
        ...Object.keys(after),
      ]) as Set<keyof typeof after>) {
        const had = !!before[provider]?.trim()
        const has = !!after[provider]?.trim()
        if (had !== has) {
          entries.push({
            at,
            key: `apiKeys.${provider}`,
            from: had ? 'key set' : 'no key',
            to: has ? 'key set' : 'no key',
          })
        }
      }
      continue
    }
    const from = logValue(current[key])
    const to = logValue(patch[key])
    if (from !== to) entries.push({ at, key, from, to })
  }
  return entries
}

const settingsLogChain = makeChain()

function appendSettingsLog(entries: SettingsLogEntry[]): Promise<void> {
  if (entries.length === 0) return Promise.resolve()
  return settingsLogChain(async () => {
    const result = await chrome.storage.local.get(SETTINGS_LOG_KEY)
    const log: SettingsLogEntry[] = result[SETTINGS_LOG_KEY] ?? []
    log.push(...entries)
    await chrome.storage.local.set({
      [SETTINGS_LOG_KEY]: log.slice(-SETTINGS_LOG_MAX),
    })
  })
}

export async function getSettingsLog(): Promise<SettingsLogEntry[]> {
  const result = await chrome.storage.local.get(SETTINGS_LOG_KEY)
  return result[SETTINGS_LOG_KEY] ?? []
}

export async function clearSettingsLog(): Promise<void> {
  await chrome.storage.local.remove(SETTINGS_LOG_KEY)
}

// ---------------------------------------------------------------------------
// "What's new" tracking — the last extension version the user acknowledged in
// the popup. Undefined until first set; the popup adopts the current version
// silently on first run so it never shows a changelog for the version that
// introduced changelogs.
// ---------------------------------------------------------------------------

export async function getLastSeenVersion(): Promise<string | undefined> {
  const result = await chrome.storage.local.get(LAST_SEEN_VERSION_KEY)
  const value = result[LAST_SEEN_VERSION_KEY]
  return typeof value === 'string' ? value : undefined
}

export async function setLastSeenVersion(version: string): Promise<void> {
  await chrome.storage.local.set({ [LAST_SEEN_VERSION_KEY]: version })
}

// ---------------------------------------------------------------------------
// Review nudge — one in-popup "enjoying it? rate it" card, shown once the
// extension has earned it (installed a while, blocked plenty) and never again
// after a click or dismiss. Deliberately NOT an OS notification: that needs
// the warning-level `notifications` permission and interrupts people outside
// the extension. `since` is stamped on the first popup open after this
// shipped, so existing installs get the same grace period as new ones.
// ---------------------------------------------------------------------------

const REVIEW_NUDGE_KEY = 'skipSensei.reviewNudge'

export interface ReviewNudge {
  /** Epoch ms of the first popup open that saw this feature. */
  since: number
  /** true once the user clicked through or dismissed — never show again. */
  done: boolean
}

export async function getReviewNudge(): Promise<ReviewNudge> {
  const result = await chrome.storage.local.get(REVIEW_NUDGE_KEY)
  const stored = result[REVIEW_NUDGE_KEY]
  if (stored && typeof stored.since === 'number') {
    return { since: stored.since, done: stored.done === true }
  }
  const fresh: ReviewNudge = { since: Date.now(), done: false }
  await chrome.storage.local.set({ [REVIEW_NUDGE_KEY]: fresh })
  return fresh
}

export async function finishReviewNudge(): Promise<void> {
  const current = await getReviewNudge()
  await chrome.storage.local.set({
    [REVIEW_NUDGE_KEY]: { ...current, done: true },
  })
}

// ---------------------------------------------------------------------------
// Feature activity log — what the features actually DID (ad skipped, popup
// hidden, cookie banner answered, selector healed…), newest last. Writes are
// chained (concurrent SW calls used to interleave and drop entries) AND must
// come from the service worker: content scripts route through the
// 'skipSensei:logActivity' message — a direct call from a tab would write on
// that tab's own chain and race every other context.
// ---------------------------------------------------------------------------

const ACTIVITY_LOG_KEY = 'skipSensei.activityLog'
const ACTIVITY_LOG_MAX = 300

export interface ActivityEntry {
  at: number
  /** Which feature acted (matches the option labels where possible). */
  feature: string
  /** What actually happened, human-readable. */
  action: string
  /** Hostname or video id it happened on. */
  site?: string
}

const activityChain = makeChain()

export function recordActivity(
  feature: string,
  action: string,
  site?: string,
): Promise<void> {
  return activityChain(async () => {
    const result = await chrome.storage.local.get(ACTIVITY_LOG_KEY)
    const entries: ActivityEntry[] = result[ACTIVITY_LOG_KEY] ?? []
    entries.push({ at: Date.now(), feature, action, ...(site ? { site } : {}) })
    await chrome.storage.local.set({
      [ACTIVITY_LOG_KEY]: entries.slice(-ACTIVITY_LOG_MAX),
    })
  })
}

export async function getActivityLog(): Promise<ActivityEntry[]> {
  const result = await chrome.storage.local.get(ACTIVITY_LOG_KEY)
  return result[ACTIVITY_LOG_KEY] ?? []
}

export async function clearActivityLog(): Promise<void> {
  await chrome.storage.local.remove(ACTIVITY_LOG_KEY)
}

/** Add/remove a hostname from the "Block all ads" allowlist. Returns updated settings. */
export async function setSiteAllowlisted(
  hostname: string,
  allowlisted: boolean,
): Promise<Settings> {
  const host = hostname.trim().toLowerCase()
  const current = await getSettings()
  const set = new Set(current.allowlist)
  if (allowlisted) set.add(host)
  else set.delete(host)
  return updateSettings({ allowlist: [...set] })
}

export function onSettingsChanged(callback: (settings: Settings) => void) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[SETTINGS_KEY]) {
      callback({ ...DEFAULT_SETTINGS, ...changes[SETTINGS_KEY].newValue })
    }
  })
}

/** Local date "YYYY-MM-DD" — the key for the daily counters. Local, not UTC:
 *  "today" should roll over at the user's midnight. */
function localDayKey(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Each lifetime counter's daily twin — incrementStat bumps both. */
const TODAY_TWIN: Record<LifetimeStatKey, Exclude<keyof TodayStats, 'date'>> = {
  allTimeAdSkips: 'adSkips',
  allTimeSponsorSkips: 'sponsorSkips',
  allTimeYtAdsHidden: 'ytAdsHidden',
  allTimeWebAdsBlocked: 'webAdsBlocked',
  allTimeTrackersBlocked: 'trackersBlocked',
  allTimeCookiesBlocked: 'cookiesBlocked',
}

/** A fresh copy of `today`, zeroed if the stored date isn't today. Always a
 *  clone — never hand out a reference into DEFAULT_STATS/EMPTY_TODAY. */
function normalizeToday(today: TodayStats | undefined): TodayStats {
  const day = localDayKey()
  if (today && today.date === day) return { ...today }
  return { ...EMPTY_TODAY, date: day }
}

/** Days of per-day history kept for the popup's 7/30-day ranges. */
const HISTORY_DAYS = 30

/** `history` with yesterday's (or older) `today` folded in when the date has
 *  rolled over. Pure: the caller persists it on its next write. Days with
 *  nothing counted are skipped — an empty entry says nothing. */
function rollHistory(
  history: TodayStats[] | undefined,
  today: TodayStats | undefined,
): TodayStats[] {
  const list = Array.isArray(history) ? [...history] : []
  if (today && today.date && today.date !== localDayKey()) {
    const counted =
      today.adSkips + today.sponsorSkips + today.ytAdsHidden +
      today.webAdsBlocked + today.trackersBlocked + today.cookiesBlocked
    if (counted > 0 && !list.some((d) => d.date === today.date)) list.push({ ...today })
  }
  list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  return list.slice(-HISTORY_DAYS)
}

export async function getStats(): Promise<Stats> {
  const result = await chrome.storage.local.get(STATS_KEY)
  const stored = result[STATS_KEY] ?? {}
  return {
    ...DEFAULT_STATS,
    ...stored,
    today: normalizeToday(stored.today),
    history: rollHistory(stored.history, stored.today),
  }
}

export async function incrementStat(
  key: LifetimeStatKey,
  amount = 1,
): Promise<Stats> {
  const next = { ...(await getStats()) } // getStats already cloned+rolled today
  next[key] += amount
  next.today[TODAY_TWIN[key]] += amount
  await chrome.storage.local.set({ [STATS_KEY]: next })
  return next
}

export function onStatsChanged(callback: (stats: Stats) => void) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[STATS_KEY]) {
      callback({ ...DEFAULT_STATS, ...changes[STATS_KEY].newValue })
    }
  })
}

/** Reset lifetime AND today counters to zero (the popup's reset-stats). */
export async function resetStats(): Promise<void> {
  await chrome.storage.local.set({
    [STATS_KEY]: { ...DEFAULT_STATS, today: normalizeToday(undefined), history: [] },
  })
}

// ---------------------------------------------------------------------------
// YouTube ad-wall back-off notice. When YouTube's "ad blocker detected" wall is
// hit, the ad engine auto-disables aggressive mode and drops this flag; the
// popup surfaces a one-time recovery notice (the flag itself is session-tied,
// so tell the user how to fully clear it). Dismissing clears the flag.
// ---------------------------------------------------------------------------
const YT_BACKOFF_KEY = 'skipSensei.ytBackoff'

export interface YtBackoff {
  at: number
  walls: number
}

export async function setYtBackoff(walls: number): Promise<void> {
  await chrome.storage.local.set({ [YT_BACKOFF_KEY]: { at: Date.now(), walls } })
}

export async function getYtBackoff(): Promise<YtBackoff | null> {
  const result = await chrome.storage.local.get(YT_BACKOFF_KEY)
  return (result[YT_BACKOFF_KEY] as YtBackoff | undefined) ?? null
}

export async function clearYtBackoff(): Promise<void> {
  await chrome.storage.local.remove(YT_BACKOFF_KEY)
}

// ---------------------------------------------------------------------------
// Daily counters feeding the telemetry rollup.
//
// Per-event telemetry can't answer "how often" questions here: reportEvent
// caps at 20 events/hour AND drops events whose field values repeat inside
// that hour, so identical outcomes (the common case) collapse into one. What
// survives is biased toward unusual values. Counting locally and shipping one
// aggregate a day gives an honest denominator instead.
// ---------------------------------------------------------------------------
const DAILY_KEY = 'skipSensei.dailyCounters'

export type DailyCounter =
  | 'walls'
  | 'breakerTrips'
  | 'skipFailures'
  | 'selfHeals'
  | 'cosmeticUnhides'
  | 'rulesetEnableFailures'
  | 'visitorClearTried'
  | 'visitorClearFailed'
  | 'fullClears'
  // UI-usage counters: how the extension's OWN surfaces get used (popup opens,
  // which toggles get flipped). Counts of our controls only — nothing about
  // what pages the user visits ever rides these. `uiSet_<settingsKey>` counts
  // changes to that setting; the service worker validates the key before
  // bumping (see the uiUsage message handler).
  | 'uiPopupOpens'
  | 'uiControlsTab'
  | 'uiOptionsOpens'
  | 'uiSitePauses'
  | 'uiShares'
  | 'uiReviews'
  | `uiSet_${string}`

interface DailyCounters {
  /** Local YYYY-MM-DD the counts belong to; a new day resets them. */
  day: string
  counts: Partial<Record<DailyCounter, number>>
}

/** Local date, matching localDayKey below — 'today' must roll over at the
 * user's midnight, not UTC's, or a rollup straddles two of their days. */
const today = () => {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const dailyChain = makeChain()

export function bumpDailyCounter(name: DailyCounter, by = 1): Promise<void> {
  return dailyChain(async () => {
    const result = await chrome.storage.local.get(DAILY_KEY)
    const cur: DailyCounters = result[DAILY_KEY] ?? { day: today(), counts: {} }
    const fresh: DailyCounters =
      cur.day === today() ? cur : { day: today(), counts: {} }
    fresh.counts[name] = (fresh.counts[name] ?? 0) + by
    await chrome.storage.local.set({ [DAILY_KEY]: fresh })
  })
}

export async function getDailyCounters(): Promise<DailyCounters> {
  const result = await chrome.storage.local.get(DAILY_KEY)
  return result[DAILY_KEY] ?? { day: today(), counts: {} }
}

/**
 * Atomically take the counters and reset the store — ON the write chain, so a
 * bump landing mid-rollup queues behind the drain and survives into the next
 * day's counts instead of being wiped by the reset. (The rollup used to do an
 * unchained read → network send → reset; anything counted during the send
 * window vanished without ever appearing in a rollup.)
 */
export function drainDailyCounters(): Promise<DailyCounters> {
  let snapshot: DailyCounters = { day: today(), counts: {} }
  return dailyChain(async () => {
    const result = await chrome.storage.local.get(DAILY_KEY)
    snapshot = result[DAILY_KEY] ?? { day: today(), counts: {} }
    await chrome.storage.local.set({
      [DAILY_KEY]: { day: today(), counts: {} },
    })
  }).then(() => snapshot)
}

/** Put a drained snapshot back (the send was dropped, e.g. by the event
 * budget) by summing it into whatever accumulated since. If the local day has
 * rolled over since the drain, the snapshot is stale and is discarded rather
 * than mislabelled into the new day. */
export function restoreDailyCounters(snapshot: DailyCounters): Promise<void> {
  return dailyChain(async () => {
    const result = await chrome.storage.local.get(DAILY_KEY)
    const cur: DailyCounters = result[DAILY_KEY] ?? { day: today(), counts: {} }
    if (cur.day !== snapshot.day) return
    const merged: DailyCounters = { day: cur.day, counts: { ...cur.counts } }
    for (const [name, count] of Object.entries(snapshot.counts) as Array<
      [DailyCounter, number | undefined]
    >) {
      merged.counts[name] = (merged.counts[name] ?? 0) + (count ?? 0)
    }
    await chrome.storage.local.set({ [DAILY_KEY]: merged })
  })
}

// ---------------------------------------------------------------------------
// How long ad skips actually take.
//
// This exists because the question "is a skip a flicker or five seconds?"
// decides whether first-party pruning is worth the enforcement walls it
// provokes — and it was unanswerable. The durations were only ever written
// into free-text activity lines ("skipped 2 ads in 1.2s"), which can't be
// aggregated without parsing prose, and into telemetry, which needs a key
// nobody can read back on demand. So record them structurally, locally.
// ---------------------------------------------------------------------------
const SKIP_TIMINGS_KEY = 'skipSensei.skipTimings'
/** Recent skips only — enough for a stable median and tail, cheap to store. */
const SKIP_TIMINGS_MAX = 400

export interface SkipTiming {
  at: number
  /** Seconds from ad-break start to cleared. */
  s: number
  /** Which mechanism did it: skip button, fast-forward, stuck recovery. */
  m: string
  /** Ads in the break (a pod counts as one entry). */
  ads: number
}

/** SERVICE WORKER ONLY — content scripts route through the
 * 'skipSensei:skipTiming' message. The chain serializes writers in one
 * context; two watch tabs calling this directly would each run their own
 * chain and race the shared list (each tab has its own module instance). */
const skipTimingChain = makeChain()

export function recordSkipTiming(entry: Omit<SkipTiming, 'at'>): Promise<void> {
  return skipTimingChain(async () => {
    const result = await chrome.storage.local.get(SKIP_TIMINGS_KEY)
    const list: SkipTiming[] = result[SKIP_TIMINGS_KEY] ?? []
    list.push({ ...entry, at: Date.now() })
    await chrome.storage.local.set({
      [SKIP_TIMINGS_KEY]: list.slice(-SKIP_TIMINGS_MAX),
    })
  })
}

export async function getSkipTimings(): Promise<SkipTiming[]> {
  const result = await chrome.storage.local.get(SKIP_TIMINGS_KEY)
  return result[SKIP_TIMINGS_KEY] ?? []
}

export async function clearSkipTimings(): Promise<void> {
  await chrome.storage.local.remove(SKIP_TIMINGS_KEY)
}

// ---------------------------------------------------------------------------
// Playback positions, so a reload never costs the user their place — a manual
// ⌘R, a crash, or the cookie clear the anti-adblock wall forces. YouTube only
// restores position from watch history, which is exactly what a cookie clear
// destroys, so we keep our own copy locally.
// ---------------------------------------------------------------------------
const RESUME_KEY = 'skipSensei.resumePositions'
/** Positions older than this are stale — you've moved on. */
const RESUME_MAX_AGE_MS = 12 * 60 * 60 * 1000
/** Cap the map so a heavy YouTube user's storage doesn't grow without bound. */
const RESUME_MAX_ENTRIES = 60

interface ResumeEntry {
  /** Seconds into the video. */
  t: number
  /** When it was recorded. */
  at: number
}

/** SERVICE WORKER ONLY — content scripts route through the
 * 'skipSensei:resumeSave' / 'skipSensei:resumeForget' messages. Save and
 * forget share one chain: two watch tabs write the same map, and each tab's
 * own module instance would otherwise serialize against nothing but itself. */
const resumeChain = makeChain()

export function recordResumePosition(
  videoId: string,
  seconds: number,
): Promise<void> {
  return resumeChain(async () => {
    const result = await chrome.storage.local.get(RESUME_KEY)
    const map: Record<string, ResumeEntry> = result[RESUME_KEY] ?? {}
    map[videoId] = { t: seconds, at: Date.now() }
    const fresh = Object.entries(map)
      .filter(([, e]) => Date.now() - e.at < RESUME_MAX_AGE_MS)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, RESUME_MAX_ENTRIES)
    await chrome.storage.local.set({ [RESUME_KEY]: Object.fromEntries(fresh) })
  })
}

/** Stored position for a video, or null when there's nothing worth restoring. */
export async function getResumePosition(videoId: string): Promise<number | null> {
  const result = await chrome.storage.local.get(RESUME_KEY)
  const entry: ResumeEntry | undefined = (result[RESUME_KEY] ?? {})[videoId]
  if (!entry) return null
  if (Date.now() - entry.at >= RESUME_MAX_AGE_MS) return null
  return entry.t
}

export function forgetResumePosition(videoId: string): Promise<void> {
  // Same chain as the saves: an unchained forget used to read the map while a
  // chained save was in flight and write the stale copy back — resurrecting
  // the deleted entry or dropping the concurrent save.
  return resumeChain(async () => {
    const result = await chrome.storage.local.get(RESUME_KEY)
    const map: Record<string, ResumeEntry> = result[RESUME_KEY] ?? {}
    if (!(videoId in map)) return
    delete map[videoId]
    await chrome.storage.local.set({ [RESUME_KEY]: map })
  })
}

// ---------------------------------------------------------------------------
// "Remind me later" from onboarding's Gemini-key step: the popup shows a
// one-time banner while this flag is set. Cleared on dismiss, on opening
// settings from the banner, or silently once a key/provider is configured.
// ---------------------------------------------------------------------------
const KEY_REMINDER_KEY = 'skipSensei.keyReminder'

export async function setKeyReminder(on: boolean): Promise<void> {
  if (on) await chrome.storage.local.set({ [KEY_REMINDER_KEY]: true })
  else await chrome.storage.local.remove(KEY_REMINDER_KEY)
}

export async function getKeyReminder(): Promise<boolean> {
  const result = await chrome.storage.local.get(KEY_REMINDER_KEY)
  return result[KEY_REMINDER_KEY] === true
}

// ---------------------------------------------------------------------------
// Anti-adblock wall notices (general web). The cosmetic content script detects
// when a site is showing an "you're using an ad blocker" wall and records it
// per-hostname; the popup surfaces a recovery notice for the active tab with a
// one-click "clear this site's cookies" action. Records expire after 7 days and
// the map is capped so it can't grow unbounded.
// ---------------------------------------------------------------------------
const ADBLOCK_WALL_KEY = 'skipSensei.adblockWalls'
const ADBLOCK_WALL_TTL_MS = 7 * 24 * 60 * 60 * 1000
const ADBLOCK_WALL_MAX = 40

export interface AdblockWall {
  at: number
}

type AdblockWallMap = Record<string, AdblockWall>

async function readAdblockWalls(): Promise<AdblockWallMap> {
  const result = await chrome.storage.local.get(ADBLOCK_WALL_KEY)
  return (result[ADBLOCK_WALL_KEY] as AdblockWallMap | undefined) ?? {}
}

/**
 * Chain for the low-frequency learned/derived maps below (adblock walls,
 * healed selectors, the gapfill family, audit verdicts). Serializes writers
 * within a context; the residual risk is cross-context (two tabs' content
 * scripts writing the same map in the same instant), accepted here because
 * these writes are rare and a lost entry self-heals on the next visit —
 * unlike stats/timings/activity, which are routed through the SW instead.
 */
const learnChain = makeChain()

/** Note a wall on `host`. Throttled: a fresh record isn't overwritten, so the
 * notice doesn't re-surface every page load a detected site is open. */
export function recordAdblockWall(host: string): Promise<void> {
  if (!host) return Promise.resolve()
  return learnChain(async () => {
    const map = await readAdblockWalls()
    const existing = map[host]
    if (existing && Date.now() - existing.at < ADBLOCK_WALL_TTL_MS) return
    map[host] = { at: Date.now() }
    // Cap: keep the most recent records only.
    const trimmed = Object.fromEntries(
      Object.entries(map)
        .sort((a, b) => b[1].at - a[1].at)
        .slice(0, ADBLOCK_WALL_MAX),
    )
    await chrome.storage.local.set({ [ADBLOCK_WALL_KEY]: trimmed })
  })
}

export async function getAdblockWall(host: string): Promise<AdblockWall | null> {
  if (!host) return null
  const wall = (await readAdblockWalls())[host]
  if (!wall) return null
  return Date.now() - wall.at < ADBLOCK_WALL_TTL_MS ? wall : null
}

export function clearAdblockWall(host: string): Promise<void> {
  if (!host) return Promise.resolve()
  return learnChain(async () => {
    const map = await readAdblockWalls()
    if (!(host in map)) return
    delete map[host]
    await chrome.storage.local.set({ [ADBLOCK_WALL_KEY]: map })
  })
}

// ---------------------------------------------------------------------------
// Per-videoId analysis cache (LRU-ish: index ordered by insertion, oldest
// evicted). Index writes are chained: two analyses finishing concurrently
// (different videos — inflight only dedupes per-video) used to race the index
// and drop an entry, orphaning a cache record that then never got evicted.
// ---------------------------------------------------------------------------

const cacheChain = makeChain()

export async function getCachedAnalysis(
  videoId: string,
): Promise<VideoAnalysis | null> {
  const key = CACHE_PREFIX + videoId
  const result = await chrome.storage.local.get(key)
  return (result[key] as VideoAnalysis | undefined) ?? null
}

export function setCachedAnalysis(analysis: VideoAnalysis): Promise<void> {
  return cacheChain(async () => {
    const indexResult = await chrome.storage.local.get(CACHE_INDEX_KEY)
    let index: string[] = indexResult[CACHE_INDEX_KEY] ?? []
    index = index.filter((id) => id !== analysis.videoId)
    index.push(analysis.videoId)

    const evicted = index.splice(
      0,
      Math.max(0, index.length - CACHE_MAX_ENTRIES),
    )
    if (evicted.length > 0) {
      await chrome.storage.local.remove(evicted.map((id) => CACHE_PREFIX + id))
    }
    await chrome.storage.local.set({
      [CACHE_INDEX_KEY]: index,
      [CACHE_PREFIX + analysis.videoId]: analysis,
    })
  })
}

/** Drop one video's cached analysis (+ its index entry) so a re-analyze
 * actually re-fetches the transcript and re-runs the AI instead of returning
 * the previous verdict. */
export function deleteCachedAnalysis(videoId: string): Promise<void> {
  return cacheChain(async () => {
    await chrome.storage.local.remove(CACHE_PREFIX + videoId)
    const indexResult = await chrome.storage.local.get(CACHE_INDEX_KEY)
    const index: string[] = indexResult[CACHE_INDEX_KEY] ?? []
    const next = index.filter((id) => id !== videoId)
    if (next.length !== index.length)
      await chrome.storage.local.set({ [CACHE_INDEX_KEY]: next })
  })
}

// ---------------------------------------------------------------------------
// Self-healed selectors (Phase 8) — AI-discovered selectors that repair the
// hardcoded ones when YouTube changes its DOM. Keyed by target (e.g. skipButton).
// ---------------------------------------------------------------------------

const HEALED_KEY = 'skipSensei.healedSelectors'

export async function getHealedSelectors(): Promise<Record<string, string[]>> {
  const result = await chrome.storage.local.get(HEALED_KEY)
  return result[HEALED_KEY] ?? {}
}

export function addHealedSelector(
  target: string,
  selector: string,
): Promise<void> {
  return learnChain(async () => {
    const all = await getHealedSelectors()
    const list = all[target] ?? []
    if (!list.includes(selector)) list.unshift(selector)
    all[target] = list.slice(0, 8) // keep a few most-recent
    await chrome.storage.local.set({ [HEALED_KEY]: all })
  })
}

/** Replace a healed-selector list wholesale (used to purge unsafe entries). */
export function setHealedSelectors(
  target: string,
  selectors: string[],
): Promise<void> {
  return learnChain(async () => {
    const all = await getHealedSelectors()
    all[target] = selectors
    await chrome.storage.local.set({ [HEALED_KEY]: all })
  })
}

// ---------------------------------------------------------------------------
// AI gap-filler (Phase 8b) — per-domain CSS selectors the AI found for ads
// the filter lists missed. Applied as cosmetic hiding on future visits.
// ---------------------------------------------------------------------------

const GAPFILL_KEY = 'skipSensei.gapfillSelectors'
const GAPFILL_MAX_DOMAINS = 300
const GAPFILL_MAX_PER_DOMAIN = 12

export async function getGapfillSelectors(
  domain: string,
): Promise<string[]> {
  const result = await chrome.storage.local.get(GAPFILL_KEY)
  const all: Record<string, string[]> = result[GAPFILL_KEY] ?? {}
  return all[domain] ?? []
}

export function addGapfillSelectors(
  domain: string,
  selectors: string[],
): Promise<void> {
  if (selectors.length === 0) return Promise.resolve()
  return learnChain(async () => {
    const result = await chrome.storage.local.get(GAPFILL_KEY)
    const all: Record<string, string[]> = result[GAPFILL_KEY] ?? {}
    const existing = new Set(all[domain] ?? [])
    for (const s of selectors) existing.add(s)
    all[domain] = [...existing].slice(0, GAPFILL_MAX_PER_DOMAIN)

    // Evict oldest domains if the map grows too large (insertion order).
    const domains = Object.keys(all)
    if (domains.length > GAPFILL_MAX_DOMAINS) {
      for (const d of domains.slice(0, domains.length - GAPFILL_MAX_DOMAINS)) {
        delete all[d]
      }
    }
    await chrome.storage.local.set({ [GAPFILL_KEY]: all })
  })
}

/** Replace a domain's gap-fill selectors wholesale (used to purge selectors
 * that turned out to match real UI, not ads). Empty list removes the domain. */
export function setGapfillSelectors(
  domain: string,
  selectors: string[],
): Promise<void> {
  return learnChain(async () => {
    const result = await chrome.storage.local.get(GAPFILL_KEY)
    const all: Record<string, string[]> = result[GAPFILL_KEY] ?? {}
    if (selectors.length === 0) delete all[domain]
    else all[domain] = selectors
    await chrome.storage.local.set({ [GAPFILL_KEY]: all })
  })
}

// Per-domain selectors the USER marked "not an ad" — never re-hidden or
// re-suggested by the gap-filler. The human-correction safety net.
const GAPFILL_REJECTED_KEY = 'skipSensei.gapfillRejected'

export async function getRejectedGapfill(domain: string): Promise<string[]> {
  const result = await chrome.storage.local.get(GAPFILL_REJECTED_KEY)
  const all: Record<string, string[]> = result[GAPFILL_REJECTED_KEY] ?? {}
  return all[domain] ?? []
}

export function addRejectedGapfill(
  domain: string,
  selector: string,
): Promise<void> {
  return learnChain(async () => {
    const result = await chrome.storage.local.get(GAPFILL_REJECTED_KEY)
    const all: Record<string, string[]> = result[GAPFILL_REJECTED_KEY] ?? {}
    const list = new Set(all[domain] ?? [])
    list.add(selector)
    all[domain] = [...list].slice(-50)
    await chrome.storage.local.set({ [GAPFILL_REJECTED_KEY]: all })
  })
}

/** Undo every "not an ad" rating on a domain — the popup's escape hatch for
 * mistaken 👎s (which silently disable hiding rules and whole features like
 * the slot collapser for the site). */
export function clearRejectedGapfill(domain: string): Promise<void> {
  return learnChain(async () => {
    const result = await chrome.storage.local.get(GAPFILL_REJECTED_KEY)
    const all: Record<string, string[]> = result[GAPFILL_REJECTED_KEY] ?? {}
    delete all[domain]
    await chrome.storage.local.set({ [GAPFILL_REJECTED_KEY]: all })
  })
}

// Per-domain selectors the AI proposed but the safety guard refused to apply
// (they looked like real UI). Shown in the popup review as "kept visible" so
// the user can rate them. The domain key's PRESENCE (even with an empty list)
// means "the gap-filler already scanned this domain" — that's what stops the
// once-per-domain AI scan from re-running forever on sites where every
// proposal gets vetoed.
const GAPFILL_VETOED_KEY = 'skipSensei.gapfillVetoed'

/** null = this domain has never been AI-scanned; [] = scanned, nothing vetoed. */
export async function getVetoedGapfill(domain: string): Promise<string[] | null> {
  const result = await chrome.storage.local.get(GAPFILL_VETOED_KEY)
  const all: Record<string, string[]> = result[GAPFILL_VETOED_KEY] ?? {}
  return all[domain] ?? null
}

export function setVetoedGapfill(
  domain: string,
  selectors: string[],
): Promise<void> {
  return learnChain(async () => {
    const result = await chrome.storage.local.get(GAPFILL_VETOED_KEY)
    const all: Record<string, string[]> = result[GAPFILL_VETOED_KEY] ?? {}
    const existing = new Set(all[domain] ?? [])
    for (const s of selectors) existing.add(s)
    all[domain] = [...existing].slice(0, 12)
    const domains = Object.keys(all)
    if (domains.length > 300) {
      for (const d of domains.slice(0, domains.length - 300)) delete all[d]
    }
    await chrome.storage.local.set({ [GAPFILL_VETOED_KEY]: all })
  })
}

/** Drop one selector after the user rated it; keeps the domain key (= scanned). */
export function removeVetoedGapfill(
  domain: string,
  selector: string,
): Promise<void> {
  return learnChain(async () => {
    const result = await chrome.storage.local.get(GAPFILL_VETOED_KEY)
    const all: Record<string, string[]> = result[GAPFILL_VETOED_KEY] ?? {}
    if (!all[domain]) return
    all[domain] = all[domain].filter((s) => s !== selector)
    await chrome.storage.local.set({ [GAPFILL_VETOED_KEY]: all })
  })
}

// Per-domain selectors the USER confirmed as ads after the safety guard vetoed
// them ("it IS an ad — hide it"). Exempt from the guard on future applies.
const GAPFILL_CONFIRMED_KEY = 'skipSensei.gapfillConfirmed'

export async function getConfirmedGapfill(domain: string): Promise<string[]> {
  const result = await chrome.storage.local.get(GAPFILL_CONFIRMED_KEY)
  const all: Record<string, string[]> = result[GAPFILL_CONFIRMED_KEY] ?? {}
  return all[domain] ?? []
}

export function addConfirmedGapfill(
  domain: string,
  selector: string,
): Promise<void> {
  return learnChain(async () => {
    const result = await chrome.storage.local.get(GAPFILL_CONFIRMED_KEY)
    const all: Record<string, string[]> = result[GAPFILL_CONFIRMED_KEY] ?? {}
    const list = new Set(all[domain] ?? [])
    list.add(selector)
    all[domain] = [...list].slice(-50)
    await chrome.storage.local.set({ [GAPFILL_CONFIRMED_KEY]: all })
  })
}

// ---------------------------------------------------------------------------
// AI list-hide audit verdicts. The AI reads the CONTENT of elements the
// filter lists / generic selectors are hiding and rescues false positives:
// 'ui' = the AI is certain the element is NOT an ad (site UI or user
// content) — the selector is un-hidden on this domain; 'ad' = confirmed ad,
// stays hidden and is never re-audited. Popup 👍 flips 'ui' → 'ad'.
// ---------------------------------------------------------------------------

const LIST_AUDIT_KEY = 'skipSensei.listAuditVerdicts'

export type ListAuditVerdict = 'ad' | 'ui'

export async function getListAuditVerdicts(
  domain: string,
): Promise<Record<string, ListAuditVerdict>> {
  const result = await chrome.storage.local.get(LIST_AUDIT_KEY)
  const all: Record<string, Record<string, ListAuditVerdict>> =
    result[LIST_AUDIT_KEY] ?? {}
  return all[domain] ?? {}
}

export function setListAuditVerdicts(
  domain: string,
  verdicts: Record<string, ListAuditVerdict>,
): Promise<void> {
  return learnChain(async () => {
    const result = await chrome.storage.local.get(LIST_AUDIT_KEY)
    const all: Record<string, Record<string, ListAuditVerdict>> =
      result[LIST_AUDIT_KEY] ?? {}
    const merged = { ...(all[domain] ?? {}), ...verdicts }
    // Cap per-domain entries (drop oldest keys — insertion order).
    const keys = Object.keys(merged)
    for (const k of keys.slice(0, Math.max(0, keys.length - 40)))
      delete merged[k]
    all[domain] = merged
    const domains = Object.keys(all)
    if (domains.length > 300) {
      for (const d of domains.slice(0, domains.length - 300)) delete all[d]
    }
    await chrome.storage.local.set({ [LIST_AUDIT_KEY]: all })
  })
}

// ---------------------------------------------------------------------------
// Cloud LLM usage tracking — monthly tokens/requests + daily request count.
// ---------------------------------------------------------------------------

function monthTag(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** Pacific-time date tag — providers' free-tier daily quotas reset ~midnight PT. */
function pacificDayTag(): string {
  // en-CA gives YYYY-MM-DD.
  return new Date().toLocaleDateString('en-CA', {
    timeZone: 'America/Los_Angeles',
  })
}

function freshUsage(): ApiUsage {
  return { month: monthTag(), monthly: {}, day: pacificDayTag(), dailyRequests: {} }
}

export async function getApiUsage(): Promise<ApiUsage> {
  const result = await chrome.storage.local.get(USAGE_KEY)
  let usage: ApiUsage = { ...freshUsage(), ...(result[USAGE_KEY] ?? {}) }
  // Roll over monthly / daily buckets when the period changes.
  if (usage.month !== monthTag()) {
    usage = { ...usage, month: monthTag(), monthly: {} }
  }
  if (usage.day !== pacificDayTag()) {
    usage = { ...usage, day: pacificDayTag(), dailyRequests: {} }
  }
  return usage
}

/** Chained: concurrent analyses (different videos) each record usage; an
 * unchained read-modify-write undercounted requests and tokens. */
const usageChain = makeChain()

export function recordApiUsage(
  provider: LlmProvider,
  inputTokens: number,
  outputTokens: number,
): Promise<void> {
  return usageChain(async () => {
    const usage = await getApiUsage() // handles rollover
    const m = usage.monthly[provider] ?? {
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
    }
    m.requests += 1
    m.inputTokens += inputTokens
    m.outputTokens += outputTokens
    usage.monthly[provider] = m
    usage.dailyRequests[provider] = (usage.dailyRequests[provider] ?? 0) + 1
    await chrome.storage.local.set({ [USAGE_KEY]: usage })
  })
}

export function resetApiUsage(): Promise<void> {
  return usageChain(async () => {
    await chrome.storage.local.set({ [USAGE_KEY]: freshUsage() })
  })
}

export interface CacheEntryStat {
  videoId: string
  status: string
  segments: number
  provider?: string
  analyzedAt: number
  bytes: number
}

export interface CacheStats {
  entries: CacheEntryStat[]
  /** Bytes used by the analysis cache (entries + index). */
  cacheBytes: number
  /** Bytes used by ALL of this extension's chrome.storage.local data. */
  totalBytes: number
}

/** Approximate stored size of one storage entry (Chrome counts key + JSON value). */
function entryBytes(key: string, value: unknown): number {
  return key.length + (JSON.stringify(value)?.length ?? 0)
}

/** Per-video cache sizes + totals, for the log page / options cache section. */
export async function getCacheStats(): Promise<CacheStats> {
  const all = await chrome.storage.local.get(null)
  let cacheBytes = 0
  const entries: CacheEntryStat[] = []
  for (const [key, value] of Object.entries(all)) {
    if (key === CACHE_INDEX_KEY) {
      cacheBytes += entryBytes(key, value)
      continue
    }
    if (!key.startsWith(CACHE_PREFIX)) continue
    const bytes = entryBytes(key, value)
    cacheBytes += bytes
    const analysis = value as VideoAnalysis
    entries.push({
      videoId: analysis.videoId ?? key.slice(CACHE_PREFIX.length),
      status: analysis.status ?? 'unknown',
      segments: analysis.segments?.length ?? 0,
      provider: analysis.provider,
      analyzedAt: analysis.analyzedAt ?? 0,
      bytes,
    })
  }
  entries.sort((a, b) => b.analyzedAt - a.analyzedAt)
  const totalBytes = await chrome.storage.local
    .getBytesInUse(null)
    .catch(() =>
      Object.entries(all).reduce((sum, [k, v]) => sum + entryBytes(k, v), 0),
    )
  return { entries, cacheBytes, totalBytes }
}

/** Drop every cached analysis (settings, stats, and corrections survive). */
export async function clearAnalysisCache(): Promise<number> {
  const all = await chrome.storage.local.get(null)
  const keys = Object.keys(all).filter(
    (key) => key.startsWith(CACHE_PREFIX) || key === CACHE_INDEX_KEY,
  )
  await chrome.storage.local.remove(keys)
  return Math.max(0, keys.length - 1) // exclude the index from the count
}

// ---------------------------------------------------------------------------
// Reset controls (options → Reset panel). Each is scoped so the user can undo
// a specific kind of learning/state without nuking the rest.
// ---------------------------------------------------------------------------

/** The telemetry install id lives here (mirrors error-reporting.ts) — preserved
 * across a factory reset so diagnostics identity/dedup isn't fragmented. */
const INSTALL_ID_KEY = 'skipSensei.installId'

/**
 * Forget everything the AI learned about what is/isn't an ad: the 👍/👎 feedback
 * (confirmed, rejected, vetoed gap-fill selectors) and any AI-healed selectors.
 * Filter lists, settings, stats, and cache are untouched.
 */
export async function clearAdFeedback(): Promise<void> {
  await chrome.storage.local.remove([
    GAPFILL_KEY,
    GAPFILL_REJECTED_KEY,
    GAPFILL_VETOED_KEY,
    GAPFILL_CONFIRMED_KEY,
    HEALED_KEY,
  ])
}

/**
 * Reset the settings object to defaults, keeping the named fields from the
 * current settings (e.g. keep apiKeys/provider so a "reset toggles" doesn't make
 * the user re-enter keys). Pass [] to reset every setting.
 */
export async function resetSettingsToDefaults(
  preserve: (keyof Settings)[] = [],
): Promise<Settings> {
  const current = await getSettings()
  const next: Settings = { ...DEFAULT_SETTINGS }
  for (const key of preserve) {
    ;(next as unknown as Record<string, unknown>)[key] = current[key]
  }
  await chrome.storage.local.set({ [SETTINGS_KEY]: next })
  void appendSettingsLog(diffSettings(current, next))
  return next
}

/**
 * Full factory reset: wipe all extension data and restore defaults. Preserves
 * the telemetry install id and the last-seen version (so the "what's new"
 * banner doesn't re-appear), and optionally the AI provider + API keys.
 */
export async function factoryReset(
  opts: { keepApiKeys?: boolean } = {},
): Promise<void> {
  const all = await chrome.storage.local.get(null)
  const prevSettings: Partial<Settings> = all[SETTINGS_KEY] ?? {}
  await chrome.storage.local.clear()

  const settings: Settings = { ...DEFAULT_SETTINGS }
  if (opts.keepApiKeys) {
    settings.apiKeys = prevSettings.apiKeys ?? {}
    if (prevSettings.llmProvider) settings.llmProvider = prevSettings.llmProvider
    if (prevSettings.model !== undefined) settings.model = prevSettings.model
    if (prevSettings.openclawUrl) settings.openclawUrl = prevSettings.openclawUrl
  }

  const restore: Record<string, unknown> = { [SETTINGS_KEY]: settings }
  if (all[INSTALL_ID_KEY]) restore[INSTALL_ID_KEY] = all[INSTALL_ID_KEY]
  if (all[LAST_SEEN_VERSION_KEY])
    restore[LAST_SEEN_VERSION_KEY] = all[LAST_SEEN_VERSION_KEY]
  await chrome.storage.local.set(restore)
}

// ---------------------------------------------------------------------------
// User corrections ("that was wrong") — raw log for tuning, plus the cached
// segment is flagged dismissed so it is never auto-skipped again.
// ---------------------------------------------------------------------------

export interface Correction {
  videoId: string
  start: number
  end: number
  reportedAt: number
}

const correctionsChain = makeChain()

export async function recordCorrection(
  videoId: string,
  start: number,
  end: number,
) {
  await correctionsChain(async () => {
    const result = await chrome.storage.local.get(CORRECTIONS_KEY)
    const corrections: Correction[] = result[CORRECTIONS_KEY] ?? []
    corrections.push({ videoId, start, end, reportedAt: Date.now() })
    await chrome.storage.local.set({
      [CORRECTIONS_KEY]: corrections.slice(-CORRECTIONS_MAX_ENTRIES),
    })
  })

  const analysis = await getCachedAnalysis(videoId)
  if (analysis) {
    for (const segment of analysis.segments) {
      // Tolerance: the reported times come straight from the segment object,
      // but survive float round-trips through storage defensively.
      if (
        Math.abs(segment.start - start) < 0.5 &&
        Math.abs(segment.end - end) < 0.5
      ) {
        segment.dismissed = true
      }
    }
    await setCachedAnalysis(analysis)
  }
}
