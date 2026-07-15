import {
  DEFAULT_SETTINGS,
  DEFAULT_STATS,
  type ApiUsage,
  type LlmProvider,
  type Settings,
  type Stats,
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

async function appendSettingsLog(entries: SettingsLogEntry[]) {
  if (entries.length === 0) return
  const result = await chrome.storage.local.get(SETTINGS_LOG_KEY)
  const log: SettingsLogEntry[] = result[SETTINGS_LOG_KEY] ?? []
  log.push(...entries)
  await chrome.storage.local.set({
    [SETTINGS_LOG_KEY]: log.slice(-SETTINGS_LOG_MAX),
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
// Feature activity log — what the features actually DID (ad skipped, popup
// hidden, cookie banner answered, selector healed…), newest last. Written by
// the service worker only, so entries never race each other.
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

export async function recordActivity(
  feature: string,
  action: string,
  site?: string,
): Promise<void> {
  const result = await chrome.storage.local.get(ACTIVITY_LOG_KEY)
  const entries: ActivityEntry[] = result[ACTIVITY_LOG_KEY] ?? []
  entries.push({ at: Date.now(), feature, action, ...(site ? { site } : {}) })
  await chrome.storage.local.set({
    [ACTIVITY_LOG_KEY]: entries.slice(-ACTIVITY_LOG_MAX),
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

export async function getStats(): Promise<Stats> {
  const result = await chrome.storage.local.get(STATS_KEY)
  return { ...DEFAULT_STATS, ...(result[STATS_KEY] ?? {}) }
}

export async function incrementStat(
  key: keyof Stats,
  amount = 1,
): Promise<Stats> {
  const next = { ...(await getStats()) }
  next[key] += amount
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

/** Reset the lifetime stats to zero (the popup's all-time counters). Session
 *  stats live in storage.session and are cleared separately by the SW. */
export async function resetStats(): Promise<void> {
  await chrome.storage.local.set({ [STATS_KEY]: DEFAULT_STATS })
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

/** Note a wall on `host`. Throttled: a fresh record isn't overwritten, so the
 * notice doesn't re-surface every page load a detected site is open. */
export async function recordAdblockWall(host: string): Promise<void> {
  if (!host) return
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
}

export async function getAdblockWall(host: string): Promise<AdblockWall | null> {
  if (!host) return null
  const wall = (await readAdblockWalls())[host]
  if (!wall) return null
  return Date.now() - wall.at < ADBLOCK_WALL_TTL_MS ? wall : null
}

export async function clearAdblockWall(host: string): Promise<void> {
  if (!host) return
  const map = await readAdblockWalls()
  if (!(host in map)) return
  delete map[host]
  await chrome.storage.local.set({ [ADBLOCK_WALL_KEY]: map })
}

// ---------------------------------------------------------------------------
// Per-videoId analysis cache (LRU-ish: index ordered by insertion, oldest evicted)
// ---------------------------------------------------------------------------

export async function getCachedAnalysis(
  videoId: string,
): Promise<VideoAnalysis | null> {
  const key = CACHE_PREFIX + videoId
  const result = await chrome.storage.local.get(key)
  return (result[key] as VideoAnalysis | undefined) ?? null
}

export async function setCachedAnalysis(analysis: VideoAnalysis) {
  const indexResult = await chrome.storage.local.get(CACHE_INDEX_KEY)
  let index: string[] = indexResult[CACHE_INDEX_KEY] ?? []
  index = index.filter((id) => id !== analysis.videoId)
  index.push(analysis.videoId)

  const evicted = index.splice(0, Math.max(0, index.length - CACHE_MAX_ENTRIES))
  if (evicted.length > 0) {
    await chrome.storage.local.remove(evicted.map((id) => CACHE_PREFIX + id))
  }
  await chrome.storage.local.set({
    [CACHE_INDEX_KEY]: index,
    [CACHE_PREFIX + analysis.videoId]: analysis,
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

export async function addHealedSelector(target: string, selector: string) {
  const all = await getHealedSelectors()
  const list = all[target] ?? []
  if (!list.includes(selector)) list.unshift(selector)
  all[target] = list.slice(0, 8) // keep a few most-recent
  await chrome.storage.local.set({ [HEALED_KEY]: all })
}

/** Replace a healed-selector list wholesale (used to purge unsafe entries). */
export async function setHealedSelectors(target: string, selectors: string[]) {
  const all = await getHealedSelectors()
  all[target] = selectors
  await chrome.storage.local.set({ [HEALED_KEY]: all })
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

export async function addGapfillSelectors(domain: string, selectors: string[]) {
  if (selectors.length === 0) return
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
}

/** Replace a domain's gap-fill selectors wholesale (used to purge selectors
 * that turned out to match real UI, not ads). Empty list removes the domain. */
export async function setGapfillSelectors(domain: string, selectors: string[]) {
  const result = await chrome.storage.local.get(GAPFILL_KEY)
  const all: Record<string, string[]> = result[GAPFILL_KEY] ?? {}
  if (selectors.length === 0) delete all[domain]
  else all[domain] = selectors
  await chrome.storage.local.set({ [GAPFILL_KEY]: all })
}

// Per-domain selectors the USER marked "not an ad" — never re-hidden or
// re-suggested by the gap-filler. The human-correction safety net.
const GAPFILL_REJECTED_KEY = 'skipSensei.gapfillRejected'

export async function getRejectedGapfill(domain: string): Promise<string[]> {
  const result = await chrome.storage.local.get(GAPFILL_REJECTED_KEY)
  const all: Record<string, string[]> = result[GAPFILL_REJECTED_KEY] ?? {}
  return all[domain] ?? []
}

export async function addRejectedGapfill(domain: string, selector: string) {
  const result = await chrome.storage.local.get(GAPFILL_REJECTED_KEY)
  const all: Record<string, string[]> = result[GAPFILL_REJECTED_KEY] ?? {}
  const list = new Set(all[domain] ?? [])
  list.add(selector)
  all[domain] = [...list].slice(-50)
  await chrome.storage.local.set({ [GAPFILL_REJECTED_KEY]: all })
}

/** Undo every "not an ad" rating on a domain — the popup's escape hatch for
 * mistaken 👎s (which silently disable hiding rules and whole features like
 * the slot collapser for the site). */
export async function clearRejectedGapfill(domain: string) {
  const result = await chrome.storage.local.get(GAPFILL_REJECTED_KEY)
  const all: Record<string, string[]> = result[GAPFILL_REJECTED_KEY] ?? {}
  delete all[domain]
  await chrome.storage.local.set({ [GAPFILL_REJECTED_KEY]: all })
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

export async function setVetoedGapfill(domain: string, selectors: string[]) {
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
}

/** Drop one selector after the user rated it; keeps the domain key (= scanned). */
export async function removeVetoedGapfill(domain: string, selector: string) {
  const result = await chrome.storage.local.get(GAPFILL_VETOED_KEY)
  const all: Record<string, string[]> = result[GAPFILL_VETOED_KEY] ?? {}
  if (!all[domain]) return
  all[domain] = all[domain].filter((s) => s !== selector)
  await chrome.storage.local.set({ [GAPFILL_VETOED_KEY]: all })
}

// Per-domain selectors the USER confirmed as ads after the safety guard vetoed
// them ("it IS an ad — hide it"). Exempt from the guard on future applies.
const GAPFILL_CONFIRMED_KEY = 'skipSensei.gapfillConfirmed'

export async function getConfirmedGapfill(domain: string): Promise<string[]> {
  const result = await chrome.storage.local.get(GAPFILL_CONFIRMED_KEY)
  const all: Record<string, string[]> = result[GAPFILL_CONFIRMED_KEY] ?? {}
  return all[domain] ?? []
}

export async function addConfirmedGapfill(domain: string, selector: string) {
  const result = await chrome.storage.local.get(GAPFILL_CONFIRMED_KEY)
  const all: Record<string, string[]> = result[GAPFILL_CONFIRMED_KEY] ?? {}
  const list = new Set(all[domain] ?? [])
  list.add(selector)
  all[domain] = [...list].slice(-50)
  await chrome.storage.local.set({ [GAPFILL_CONFIRMED_KEY]: all })
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

export async function recordApiUsage(
  provider: LlmProvider,
  inputTokens: number,
  outputTokens: number,
): Promise<void> {
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
}

export async function resetApiUsage(): Promise<void> {
  await chrome.storage.local.set({ [USAGE_KEY]: freshUsage() })
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

export async function recordCorrection(
  videoId: string,
  start: number,
  end: number,
) {
  const result = await chrome.storage.local.get(CORRECTIONS_KEY)
  const corrections: Correction[] = result[CORRECTIONS_KEY] ?? []
  corrections.push({ videoId, start, end, reportedAt: Date.now() })
  await chrome.storage.local.set({
    [CORRECTIONS_KEY]: corrections.slice(-CORRECTIONS_MAX_ENTRIES),
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
