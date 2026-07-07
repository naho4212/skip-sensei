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

const RULESET_IDS = ['ads_base', 'ads_mobile']

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
  const shouldEnable = settings.masterEnabled && settings.blockAllAds
  lastError = undefined

  try {
    const current = new Set(
      await chrome.declarativeNetRequest.getEnabledRulesets(),
    )
    const alreadyOn = RULESET_IDS.every((id) => current.has(id))
    const allOff = RULESET_IDS.every((id) => !current.has(id))

    if (shouldEnable && !alreadyOn) {
      await chrome.declarativeNetRequest.updateEnabledRulesets({
        enableRulesetIds: RULESET_IDS,
      })
    } else if (!shouldEnable && !allOff) {
      await chrome.declarativeNetRequest.updateEnabledRulesets({
        disableRulesetIds: RULESET_IDS,
      })
    }
    await syncAllowlist(settings.allowlist)
  } catch (error) {
    // Most likely the enabled-static-rule limit (other blockers using the pool).
    lastError =
      error instanceof Error ? error.message : 'Could not update ad blocking'
  }

  return getBlockerState()
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
    active = RULESET_IDS.every((id) => current.includes(id))
  } catch {
    // ignore — reported via error below
  }
  return { enabled: blockAllAds, active, error: lastError }
}

/** Wire up: enforce on startup, install, and whenever settings change. */
export function initNetBlocker() {
  chrome.runtime.onInstalled.addListener(() => void syncNetBlocker())
  chrome.runtime.onStartup.addListener(() => void syncNetBlocker())
  onSettingsChanged(() => void syncNetBlocker())
  void syncNetBlocker()
}
