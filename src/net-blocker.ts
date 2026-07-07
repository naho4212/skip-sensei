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

export interface BlockerState {
  enabled: boolean
  active: boolean
  error?: string
}

let lastError: string | undefined

export async function syncNetBlocker(): Promise<BlockerState> {
  const { blockAllAds, masterEnabled } = await getSettings()
  const shouldEnable = masterEnabled && blockAllAds
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
  } catch (error) {
    // Most likely the enabled-static-rule limit (other blockers using the pool).
    lastError =
      error instanceof Error ? error.message : 'Could not update ad blocking'
  }

  return getBlockerState()
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
