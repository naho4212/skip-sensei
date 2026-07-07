import { getSettings, onSettingsChanged } from './storage'

/**
 * Shared `[skipSensei]` logger, gated on the debugLogging setting so normal
 * use leaves a clean console. The flag is cached and kept in sync so log()
 * stays synchronous at call sites.
 */

let enabled = false

void getSettings().then((s) => (enabled = s.debugLogging))
onSettingsChanged((s) => (enabled = s.debugLogging))

export function log(...args: unknown[]) {
  if (enabled) console.log('[skipSensei]', ...args)
}

export function warn(...args: unknown[]) {
  if (enabled) console.warn('[skipSensei]', ...args)
}
