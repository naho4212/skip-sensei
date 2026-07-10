import { getSettings, onSettingsChanged } from './storage'

/**
 * "Block all ads" engine (service-worker side): enables/disables the static
 * DNR filter-list rulesets based on the blockAllAds setting.
 *
 * Rulesets ship DISABLED in the manifest and are turned on at runtime here, so
 * a fresh install never trips Chrome's enabled-static-rule limit. Enabling can
 * still fail if the shared 300k rule pool is exhausted by other extensions —
 * we surface that via getBlockerState() rather than throwing.
 */

const AD_RULESET_IDS = ['ads_base', 'ads_mobile']
const TRACKER_RULESET_IDS = ['trackers']

/** Priority for allowlist rules — must beat the static block rules (priority 1). */
const ALLOWLIST_PRIORITY = 1_000_000

export interface BlockerState {
  enabled: boolean
  active: boolean
  error?: string
}

let lastError: string | undefined

/**
 * Desired ruleset state per group, derived from settings. Ad blocking is the
 * base; cookies/social/popups are opt-ins gated on their own settings AND
 * blockAllAds. URL-tracking stripping is a standalone privacy feature (needs
 * host access to actually rewrite, but enabling without it is a harmless
 * no-op). Malware/phishing blocking (URLhaus) is protection, not ad blocking —
 * standalone and on by default.
 */
function desiredRulesets(
  settings: Awaited<ReturnType<typeof getSettings>>,
): Array<{ ids: string[]; on: boolean; label: string }> {
  const master = settings.masterEnabled
  return [
    { ids: AD_RULESET_IDS, on: master && settings.blockAllAds, label: 'ad blocking' },
    { ids: TRACKER_RULESET_IDS, on: master && settings.blockTrackers, label: 'tracker blocking' },
    { ids: ['cookies'], on: master && settings.blockAllAds && settings.blockCookieNotices, label: 'cookie-notice blocking' },
    { ids: ['social'], on: master && settings.blockAllAds && settings.blockSocial, label: 'social blocking' },
    { ids: ['popups'], on: master && settings.blockAllAds && settings.blockPopups, label: 'popup blocking' },
    { ids: ['url_tracking'], on: master && settings.blockUrlTracking, label: 'URL tracking protection' },
    { ids: ['malware'], on: master && settings.blockMalware, label: 'malware blocking' },
  ]
}

/**
 * Single-flight gate. Sync triggers overlap freely — onInstalled, onStartup,
 * and the cold-start gate all fire within a second of each other at launch,
 * and settings changes add more. Concurrent runs interleave their setRulesets
 * retries and race on the shared `lastError`, so a failing run can have its
 * error cleared by a run that started later. Serialize instead: one sync at a
 * time; triggers arriving mid-run coalesce into a single follow-up run (which
 * re-reads settings, so it reflects the newest state).
 */
let syncInFlight: Promise<BlockerState> | null = null
let syncQueued = false

export function syncNetBlocker(): Promise<BlockerState> {
  if (syncInFlight) {
    syncQueued = true
    return syncInFlight
  }
  syncInFlight = (async () => {
    try {
      return await doSyncNetBlocker()
    } finally {
      syncInFlight = null
      if (syncQueued) {
        syncQueued = false
        void syncNetBlocker()
      }
    }
  })()
  return syncInFlight
}

async function doSyncNetBlocker(): Promise<BlockerState> {
  const settings = await getSettings()
  lastError = undefined

  // Each ruleset group is enabled in a SEPARATE call so that if one hits the
  // shared rule-pool limit, the others still apply.
  for (const group of desiredRulesets(settings)) {
    await setRulesets(group.ids, group.on, group.label)
  }

  try {
    await syncAllowlist(settings.allowlist)
  } catch {
    // allowlist failures are non-fatal
  }

  return getBlockerState()
}

/**
 * Cheap drift check for warm SW wakes (one settings read + one
 * getEnabledRulesets, then a full sync only if they disagree). Enabled-ruleset
 * state is Chrome-side and outlives the worker, so anything that resets it
 * mid-session — an extension reload, a failed earlier sync — would otherwise
 * persist until the next settings change or browser restart.
 */
export async function verifyNetBlocker(): Promise<void> {
  try {
    const settings = await getSettings()
    const current = new Set(
      await chrome.declarativeNetRequest.getEnabledRulesets(),
    )
    const drifted = desiredRulesets(settings).some(({ ids, on }) =>
      ids.some((id) => current.has(id) !== on),
    )
    if (drifted) await syncNetBlocker()
  } catch {
    // best-effort — the event-driven syncs still cover the common paths
  }
}

async function setRulesets(ids: string[], on: boolean, label: string) {
  // One retry for a transient failure right at launch. Note this does NOT
  // rescue the known "exceeds the rule count limit" failure after an extension
  // reload/update: Chrome can hold the previous install's static-rule
  // allocation for the rest of the browser session, and every retry — in-call,
  // on a timer, or on a later event — fails identically until restart. Keep
  // the attempt cheap rather than pretending we can wait it out; the failure
  // is surfaced through getBlockerState() so the popup can show it.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const current = new Set(
        await chrome.declarativeNetRequest.getEnabledRulesets(),
      )
      const allOn = ids.every((id) => current.has(id))
      const allOff = ids.every((id) => !current.has(id))
      if (on && !allOn) {
        await chrome.declarativeNetRequest.updateEnabledRulesets({
          enableRulesetIds: ids,
        })
      } else if (!on && !allOff) {
        await chrome.declarativeNetRequest.updateEnabledRulesets({
          disableRulesetIds: ids,
        })
      }
      return
    } catch (error) {
      if (attempt === 1) {
        // Most likely the enabled-static-rule limit (this extension's own
        // stale allocation, or other extensions using the shared pool).
        const msg =
          error instanceof Error ? error.message : `Could not update ${label}`
        lastError = `${label}: ${msg}`
        return
      }
      await new Promise((r) => setTimeout(r, 600))
    }
  }
}

/**
 * YouTube is ALWAYS exempt from NETWORK ad-blocking. Blocking YouTube's ad /
 * tracking requests is exactly what trips its "ad blocker detected"
 * enforcement (the "violates Terms of Service" wall, then hard "Video
 * unavailable" errors). And it buys almost nothing: YouTube's video ads are
 * served from the same host as the video, so they can't be network-blocked
 * anyway. YouTube ads are handled the safe way instead — the reactive Skip
 * engine (the ad plays, the impression fires, then it's skipped, which looks
 * like a user hitting "Skip") plus cosmetic hiding of display ads. Result:
 * ad-free YouTube without giving YouTube a reason to flag the session.
 */
const NETWORK_EXEMPT = ['youtube.com', 'youtube-nocookie.com', 'googlevideo.com']

/**
 * Rebuild the dynamic allow rules from the allowlist. Each hostname gets a
 * high-priority allowAllRequests rule that exempts the whole page (and its
 * subframes) from the static block rules — i.e. "pause blocking on this site".
 */
/**
 * DNR requestDomains must be clean ASCII hostnames — no scheme, port, path, or
 * spaces. updateDynamicRules validates the WHOLE rule atomically, so a single
 * malformed entry rejects it and (on a fresh profile with no prior rule) would
 * drop the NETWORK_EXEMPT YouTube exemption with it — network-blocking YouTube,
 * which we must never do. Sanitize each entry and drop anything that isn't a
 * plausible hostname so one bad allowlist input can't take the rule down.
 */
function normalizeHost(raw: string): string | null {
  const s = raw
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '') // scheme
    .replace(/[/?#].*$/, '') // path / query / fragment
    .replace(/:\d+$/, '') // port
  if (
    !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(s)
  ) {
    return null
  }
  return s
}

async function syncAllowlist(hostnames: string[]) {
  const existing = await chrome.declarativeNetRequest.getDynamicRules()
  const domains = [...NETWORK_EXEMPT, ...hostnames]
    .map(normalizeHost)
    .filter((h): h is string => h !== null)
    .filter((h, i, arr) => arr.indexOf(h) === i) // dedupe

  // A SINGLE allowAllRequests rule whose condition lists every paused hostname
  // in requestDomains — one dynamic rule no matter how large the allowlist
  // grows, instead of one rule per hostname. (allowAllRequests on a page's
  // main_frame/sub_frame exempts the whole page + its subframes from the
  // static block rules.)
  const addRules =
    domains.length === 0
      ? []
      : [
          {
            id: 1,
            priority: ALLOWLIST_PRIORITY,
            action: {
              type: 'allowAllRequests' as chrome.declarativeNetRequest.RuleActionType,
            },
            condition: {
              requestDomains: domains,
              resourceTypes: [
                'main_frame',
                'sub_frame',
              ] as chrome.declarativeNetRequest.ResourceType[],
            },
          },
        ]
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existing.map((r) => r.id),
    addRules,
  })
}

export async function getBlockerState(): Promise<BlockerState> {
  const { blockAllAds } = await getSettings()
  let active = false
  try {
    const current = await chrome.declarativeNetRequest.getEnabledRulesets()
    active = AD_RULESET_IDS.every((id) => current.includes(id))
  } catch {
    // ignore — reported via error below
  }
  return { enabled: blockAllAds, active, error: lastError }
}

export interface RulesetInfo {
  /** Rule count per ruleset id, from the build-time _counts.json manifest. */
  counts: Record<string, number>
  /** Ruleset ids Chrome currently has ENABLED (the live truth). */
  enabled: string[]
  /** Sum of all rulesets' rule counts. */
  availableTotal: number
  /** Sum of rule counts across the enabled rulesets = rules actually loaded. */
  loadedTotal: number
}

/** Build-time rule counts; immutable, so fetch once per worker lifetime. */
let ruleCounts: Record<string, number> | null = null
async function getRuleCounts(): Promise<Record<string, number>> {
  if (ruleCounts) return ruleCounts
  try {
    const url = chrome.runtime.getURL('rulesets/_counts.json')
    ruleCounts = (await (await fetch(url)).json()) as Record<string, number>
  } catch {
    ruleCounts = {}
  }
  return ruleCounts
}

/**
 * Per-ruleset rule counts plus which rulesets Chrome currently has loaded, for
 * the options "Filter rulesets" panel. `enabled` is read live from
 * getEnabledRulesets rather than inferred from settings, so a ruleset that the
 * settings asked for but Chrome refused (the static-rule-pool cap) shows as
 * enabled-in-settings but absent here — the panel's honest "loaded" signal.
 */
export async function getRulesetInfo(): Promise<RulesetInfo> {
  const counts = await getRuleCounts()
  let enabled: string[] = []
  try {
    enabled = await chrome.declarativeNetRequest.getEnabledRulesets()
  } catch {
    // getEnabledRulesets unavailable — report nothing loaded rather than lying
  }
  const availableTotal = Object.values(counts).reduce((a, b) => a + b, 0)
  const loadedTotal = enabled.reduce((sum, id) => sum + (counts[id] ?? 0), 0)
  return { counts, enabled, availableTotal, loadedTotal }
}

const AD_SET = new Set(AD_RULESET_IDS)
const TRACKER_SET = new Set(TRACKER_RULESET_IDS)
const COOKIE_SET = new Set(['cookies'])

/**
 * Count blocked web-ad requests for the popup stats + per-tab badge.
 *
 * We poll declarativeNetRequest.getMatchedRules() when a tab finishes loading.
 * Unlike onRuleMatchedDebug — which the docs restrict to UNPACKED extensions,
 * so it silently never fires in a packed Web Store build — getMatchedRules
 * works in production. It needs the declarativeNetRequestFeedback permission,
 * which we hold (and which also lifts the API's call-rate quota). A per-tab
 * high-water timestamp keeps us from recounting the same matches.
 */
/** getMatchedRules retains a tab's matches for ~5 min. When we don't know the
 *  page's load time (e.g. after an SW restart), fall back to this window so the
 *  count still reflects roughly the current page rather than nothing. */
const MATCH_RETENTION_MS = 5 * 60 * 1000

/** When a tab's current page load began — the anchor for its "blocked here"
 *  count. Seeded at navigation, NOT advanced by polling, so every poll can
 *  recompute the full page total (idempotent → no double-count). */
const tabLoadStart = new Map<number, number>()
/** High-water per tab for the CUMULATIVE stats: matches at or before this were
 *  already added to lifetime/session totals, so re-polls only add new ones. */
const lastPollTs = new Map<number, number>()

interface BlockCallbacks {
  /** New-since-last-poll counts → lifetime/session stats. One object so the
   *  recorder does ONE serialized read-modify-write (buckets land together). */
  onCounts: (c: { ads: number; trackers: number; cookies: number }) => void
  /** The tab's CURRENT full ad+tracker total → the icon badge. Set, not added:
   *  the badge is a snapshot of the page, so re-polling can't inflate it. */
  onTabCount: (tabId: number, adsPlusTrackers: number) => void
}

let callbacks: BlockCallbacks | null = null

/**
 * Count what's been blocked on a tab's current page. ONE getMatchedRules call
 * yields both the full page snapshot (for the badge, set idempotently) and the
 * delta since the last poll (added to cumulative stats). Returns the snapshot
 * counts, or null if the query failed (quota) so callers keep the last value
 * instead of showing a bogus 0.
 *
 * getMatchedRules is quota-limited (20 calls / 10 min; the feedback permission
 * does NOT exempt it — only genuine user-gesture calls are). We spend at most a
 * couple of calls per page load plus one when the popup opens, which fits
 * normal browsing; very heavy multi-tab browsing can still exhaust it, after
 * which counting pauses until the quota resets. Blocking is never affected.
 */
async function countTabBlocks(
  tabId: number,
  cb: BlockCallbacks,
): Promise<{ ads: number; trackers: number; cookies: number } | null> {
  const loadStart = tabLoadStart.get(tabId) ?? Date.now() - MATCH_RETENTION_MS
  try {
    const { rulesMatchedInfo } =
      await chrome.declarativeNetRequest.getMatchedRules({
        tabId,
        minTimeStamp: loadStart,
      })
    const since = lastPollTs.get(tabId) ?? loadStart
    let ads = 0
    let trackers = 0
    let cookies = 0
    let dAds = 0
    let dTrackers = 0
    let dCookies = 0
    let maxTs = since
    for (const info of rulesMatchedInfo) {
      const id = info.rule.rulesetId
      const isAd = AD_SET.has(id)
      const isTracker = TRACKER_SET.has(id)
      const isCookie = COOKIE_SET.has(id)
      if (isAd) ads++
      else if (isTracker) trackers++
      else if (isCookie) cookies++
      // Only matches newer than the high-water are new to the cumulative stats.
      if (info.timeStamp > since) {
        if (info.timeStamp > maxTs) maxTs = info.timeStamp
        if (isAd) dAds++
        else if (isTracker) dTrackers++
        else if (isCookie) dCookies++
      }
    }
    lastPollTs.set(tabId, maxTs + 1)
    if (dAds || dTrackers || dCookies)
      cb.onCounts({ ads: dAds, trackers: dTrackers, cookies: dCookies })
    cb.onTabCount(tabId, ads + trackers)
    return { ads, trackers, cookies }
  } catch {
    return null
  }
}

/** Live per-tab block counts for the popup, refreshed on open (a user gesture,
 *  so this getMatchedRules call is generally quota-exempt) — this is what makes
 *  "blocked here" accurate even for ads that loaded after the page finished. */
export async function getTabBlockCounts(
  tabId: number,
): Promise<{ ads: number; trackers: number; cookies: number } | null> {
  if (!callbacks) return null
  return countTabBlocks(tabId, callbacks)
}

/**
 * Wire up: enforce on startup, install, settings change; count blocks per tab
 * load. The initial sync is driven by the service worker's cold-start gate
 * (see lifecycle.ts) so a mid-session SW wake doesn't redundantly re-sync.
 */
export function initNetBlocker(cb: BlockCallbacks) {
  chrome.runtime.onInstalled.addListener(() => void syncNetBlocker())
  chrome.runtime.onStartup.addListener(() => void syncNetBlocker())
  onSettingsChanged(() => void syncNetBlocker())

  callbacks = cb
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    // Anchor the count at real navigation start (url present), so a poll counts
    // this page's matches, not the previous page's still-retained ones.
    if (changeInfo.status === 'loading' && changeInfo.url) {
      const now = Date.now()
      tabLoadStart.set(tabId, now)
      lastPollTs.set(tabId, now)
    }
    if (changeInfo.status === 'complete') {
      void countTabBlocks(tabId, cb)
      // Many sites load ads AFTER 'complete' (lazy-load, consent walls, SPA
      // routing). One delayed re-poll catches those; the badge is set to the
      // full snapshot, so this only ever corrects the number upward, never
      // double-counts. The popup's on-open query is the accurate backstop.
      setTimeout(() => void countTabBlocks(tabId, cb), 9000)
    }
  })
  chrome.tabs.onRemoved.addListener((tabId) => {
    lastPollTs.delete(tabId)
    tabLoadStart.delete(tabId)
  })
}
