import { incrementStat } from './storage'
import type { Message, SessionStats } from './types'

/**
 * Service worker: session counters + all-time stat persistence.
 * Phase 2 adds LLM calls and per-videoId segment caching here.
 */

const SESSION_STATS_KEY = 'skipSensei.sessionStats'

const EMPTY_SESSION: SessionStats = {
  sessionAdSkips: 0,
  sessionSponsorSkips: 0,
}

async function getSessionStats(): Promise<SessionStats> {
  const result = await chrome.storage.session.get(SESSION_STATS_KEY)
  return { ...EMPTY_SESSION, ...(result[SESSION_STATS_KEY] ?? {}) }
}

async function recordAdSkip() {
  await incrementStat('allTimeAdSkips')
  const session = await getSessionStats()
  session.sessionAdSkips += 1
  await chrome.storage.session.set({ [SESSION_STATS_KEY]: session })
}

chrome.runtime.onMessage.addListener(
  (message: Message, _sender, sendResponse) => {
    switch (message?.type) {
      case 'skipSensei:adSkipped':
        void recordAdSkip()
        return false
      case 'skipSensei:getSessionStats':
        void getSessionStats().then(sendResponse)
        return true // async response
      default:
        return false
    }
  },
)
