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
 * Rebuild the dynamic allow rules from the allowlist. Each hostname gets a
 * high-priority allowAllRequests rule that exempts the whole page (and its
 * subframes) from the static block rules — i.e. "pause blocking on this site".
 */
async function syncAllowlist(hostnames: string[]) {
  const existing = await chrome.declarativeNetRequest.getDynamicRules()
  const addRules = hostnames
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
    .map((hostname, i) => ({
      id: i + 1,
      priority: ALLOWLIST_PRIORITY,
      action: { type: 'allowAllRequests' as chrome.declarativeNetRequest.RuleActionType },
      condition: {
        requestDomains: [hostname],
        resourceTypes: [
          'main_frame',
          'sub_frame',
        ] as chrome.declarativeNetRequest.ResourceType[],
      },
    }))
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

const BLOCK_RULESET_IDS = new Set([...AD_RULESET_IDS, ...TRACKER_RULESET_IDS])

/**
 * Count blocked web-ad requests for the popup stats. onRuleMatchedDebug fires
 * per matched rule for unpacked extensions (which is how this is loaded).
 * Matches are batched in memory and flushed to storage to avoid hammering it.
 */
let pendingBlocks = 0
let flushTimer: ReturnType<typeof setTimeout> | null = null

function scheduleFlush(onBlocks: (n: number) => void) {
  if (flushTimer !== null) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    const n = pendingBlocks
    pendingBlocks = 0
    if (n > 0) onBlocks(n)
  }, 3000)
}

/**
 * Wire up: enforce on startup, install, settings change.
 * @param onBlocks   batched total block count → for the running stats
 * @param onTabBlock per-block callback with the tab id → for the icon badge
 */
export function initNetBlocker(
  onBlocks: (n: number) => void,
  onTabBlock: (tabId: number) => void,
) {
  chrome.runtime.onInstalled.addListener(() => void syncNetBlocker())
  chrome.runtime.onStartup.addListener(() => void syncNetBlocker())
  onSettingsChanged(() => void syncNetBlocker())

  // Only fires in unpacked/dev extensions; silently absent otherwise.
  chrome.declarativeNetRequest.onRuleMatchedDebug?.addListener((info) => {
    if (BLOCK_RULESET_IDS.has(info.rule.rulesetId)) {
      pendingBlocks++
      scheduleFlush(onBlocks)
      const tabId = info.request.tabId
      if (tabId !== undefined && tabId >= 0) onTabBlock(tabId)
    }
  })

  void syncNetBlocker()
}
