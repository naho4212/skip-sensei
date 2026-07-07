import {
  DEFAULT_SETTINGS,
  DEFAULT_STATS,
  type Settings,
  type Stats,
  type VideoAnalysis,
} from './types'

const SETTINGS_KEY = 'skipSensei.settings'
const STATS_KEY = 'skipSensei.stats'
const CACHE_PREFIX = 'skipSensei.cache.'
const CACHE_INDEX_KEY = 'skipSensei.cacheIndex'
const CORRECTIONS_KEY = 'skipSensei.corrections'

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
  const next = { ...(await getSettings()), ...patch }
  await chrome.storage.local.set({ [SETTINGS_KEY]: next })
  return next
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
