/** Shared message + settings contracts. All keys are skipSensei-namespaced. */

export interface Settings {
  masterEnabled: boolean
  adEngineEnabled: boolean
  /** Sponsor Engine ships in Phase 2; the setting exists now so the popup UI is stable. */
  sponsorEngineEnabled: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  masterEnabled: true,
  adEngineEnabled: true,
  sponsorEngineEnabled: true,
}

export interface Stats {
  allTimeAdSkips: number
  allTimeSponsorSkips: number
}

export const DEFAULT_STATS: Stats = {
  allTimeAdSkips: 0,
  allTimeSponsorSkips: 0,
}

/** How an ad was neutralized — kept for future metrics/debugging. */
export type AdSkipMethod =
  | 'skip-button'
  | 'fast-forward'
  | 'overlay-removed'
  | 'pause-overlay-dismissed'

export type Message =
  | { type: 'skipSensei:adSkipped'; method: AdSkipMethod }
  | { type: 'skipSensei:getSessionStats' }

export interface SessionStats {
  sessionAdSkips: number
  sessionSponsorSkips: number
}

/** Content-script status the popup queries via tabs.sendMessage. */
export type TabMessage = { type: 'skipSensei:getPageStatus' }

export interface PageStatus {
  isWatchPage: boolean
  adEngineActive: boolean
}
