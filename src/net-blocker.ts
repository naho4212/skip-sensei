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

export async function syncNetBlocker(): Promise<BlockerState> {
  const settings = await getSettings()
  lastError = undefined

  // Each ruleset group is enabled in a SEPARATE call so that if one hits the
  // shared rule-pool limit, the others still apply. Ad blocking is the base;
  // the rest are independent opt-ins gated on their own settings AND blockAllAds.
  const master = settings.masterEnabled
  await setRulesets(AD_RULESET_IDS, master && settings.blockAllAds, 'ad blocking')
  await setRulesets(
    TRACKER_RULESET_IDS,
    master && settings.blockTrackers,
    'tracker blocking',
  )
  await setRulesets(
    ['cookies'],
    master && settings.blockAllAds && settings.blockCookieNotices,
    'cookie-notice blocking',
  )
  await setRulesets(
    ['social'],
    master && settings.blockAllAds && settings.blockSocial,
    'social blocking',
  )
  await setRulesets(
    ['popups'],
    master && settings.blockAllAds && settings.blockPopups,
    'popup blocking',
  )
  // URL-tracking stripping is a standalone privacy feature — it does NOT
  // require "Block all ads". Needs host access (granted via the options
  // toggle) to actually rewrite URLs, but enabling the ruleset without it is
  // a harmless no-op.
  await setRulesets(
    ['url_tracking'],
    master && settings.blockUrlTracking,
    'URL tracking protection',
  )
  // Malware/phishing domain blocking (URLhaus) is protection, not ad
  // blocking — standalone and on by default.
  await setRulesets(
    ['malware'],
    master && settings.blockMalware,
    'malware blocking',
  )

  try {
    await syncAllowlist(settings.allowlist)
  } catch {
    // allowlist failures are non-fatal
  }

  return getBlockerState()
}

async function setRulesets(ids: string[], on: boolean, label: string) {
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
  } catch (error) {
    // Most likely the enabled-static-rule limit (other extensions using the pool).
    const msg = error instanceof Error ? error.message : `Could not update ${label}`
    lastError = `${label}: ${msg}`
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
async function syncAllowlist(hostnames: string[]) {
  const existing = await chrome.declarativeNetRequest.getDynamicRules()
  const domains = [
    ...NETWORK_EXEMPT,
    ...hostnames.map((h) => h.trim().toLowerCase()).filter(Boolean),
  ].filter((h, i, arr) => arr.indexOf(h) === i) // dedupe

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
const lastPollTs = new Map<number, number>()

interface BlockCallbacks {
  /** Web ad blocks (filter-list ad rulesets) → the "Web ads" stat. */
  onBlocks: (n: number) => void
  /** Tracker/analytics blocks → the "Trackers" stat. */
  onTrackers: (n: number) => void
  /** Cookie-notice blocks → the "Cookies" stat. */
  onCookies: (n: number) => void
  /** Per ad+tracker block, with the tab id → the icon badge counter. */
  onTabBlock: (tabId: number) => void
}

async function pollTabBlocks(tabId: number, cb: BlockCallbacks) {
  try {
    const since = lastPollTs.get(tabId)
    const { rulesMatchedInfo } =
      await chrome.declarativeNetRequest.getMatchedRules({
        tabId,
        ...(since !== undefined ? { minTimeStamp: since } : {}),
      })
    lastPollTs.set(tabId, Date.now())
    let ads = 0
    let trackers = 0
    let cookies = 0
    for (const info of rulesMatchedInfo) {
      const id = info.rule.rulesetId
      if (AD_SET.has(id)) ads++
      else if (TRACKER_SET.has(id)) trackers++
      else if (COOKIE_SET.has(id)) cookies++
    }
    if (ads > 0) cb.onBlocks(ads)
    if (trackers > 0) cb.onTrackers(trackers)
    if (cookies > 0) cb.onCookies(cookies)
    // Badge = everything actually blocked on the tab (ads + trackers).
    for (let i = 0; i < ads + trackers; i++) cb.onTabBlock(tabId)
  } catch {
    // Feedback permission missing or tab gone — counting is best-effort.
  }
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

  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    // New load → reset the per-tab counting window (block counts are per-load).
    if (changeInfo.status === 'loading') lastPollTs.delete(tabId)
    if (changeInfo.status === 'complete') void pollTabBlocks(tabId, cb)
  })
  chrome.tabs.onRemoved.addListener((tabId) => lastPollTs.delete(tabId))
}
