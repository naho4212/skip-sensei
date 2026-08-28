import { log } from '../log'
import { getSettings, onSettingsChanged } from '../storage'
import type {
  AdSkipMethod,
  Message,
  PageStatus,
  Settings,
  TabMessage,
} from '../types'
import { AdEngine } from './ad-engine'
import { ResumePositionTracker } from './resume-position'
import { SponsorEngine } from './sponsor-engine'
import { initYouTubeAnnoyances } from './youtube-annoyances'
import { showYouTubeNotice } from './youtube-notice'

/**
 * Content-script entry. Runs on all youtube.com pages (YouTube is an SPA, so
 * only the first page is a real load); gates engine lifecycle on watch pages
 * and re-initializes on yt-navigate-finish.
 */

let settings: Settings | null = null
let adEngine: AdEngine | null = null
let sponsorEngine: SponsorEngine | null = null
let resumeTracker: ResumePositionTracker | null = null

function isWatchPage(): boolean {
  return location.pathname === '/watch'
}

function getVideoId(): string | null {
  return new URLSearchParams(location.search).get('v')
}

function reportAdSkip(method: AdSkipMethod, count = 1, quiet = false) {
  const message: Message = { type: 'skipSensei:adSkipped', method, count, quiet }
  // Service worker may be asleep mid-restart; a dropped count isn't worth a
  // crash. The try/catch matters too: after an extension reload orphans this
  // script, sendMessage throws SYNCHRONOUSLY — tear everything down then.
  try {
    chrome.runtime.sendMessage(message).catch(() => {})
  } catch {
    adEngine?.stop()
    adEngine = null
    sponsorEngine?.stop()
    sponsorEngine = null
    document.removeEventListener('yt-navigate-finish', onNavigate)
  }
}

function syncEngines() {
  if (!settings) return
  const onWatchPage = isWatchPage()
  const videoId = getVideoId()

  const adShouldRun =
    onWatchPage && settings.masterEnabled && settings.adEngineEnabled
  if (adShouldRun && !adEngine) {
    adEngine = new AdEngine(reportAdSkip)
    adEngine.start()
    // Set expectations once: ads here are skipped as they start, not blocked.
    void showYouTubeNotice()
  } else if (!adShouldRun && adEngine) {
    adEngine.stop()
    adEngine = null
  }

  // Position memory is independent of the ad engine — someone who only wants
  // sponsor skipping (or neither) still shouldn't lose their place on reload.
  const resumeShouldRun =
    onWatchPage &&
    videoId !== null &&
    settings.masterEnabled &&
    settings.resumePlayback
  if (resumeShouldRun && !resumeTracker) {
    resumeTracker = new ResumePositionTracker(videoId!)
    resumeTracker.start()
  } else if (!resumeShouldRun && resumeTracker) {
    resumeTracker.stop()
    resumeTracker = null
  }

  const sponsorShouldRun =
    onWatchPage &&
    videoId !== null &&
    settings.masterEnabled &&
    settings.sponsorEngineEnabled
  if (sponsorShouldRun && !sponsorEngine) {
    sponsorEngine = new SponsorEngine(videoId!, () => settings!)
    sponsorEngine.start()
  } else if (!sponsorShouldRun && sponsorEngine) {
    sponsorEngine.stop()
    sponsorEngine = null
  }
}

function onNavigate() {
  // Tear down unconditionally: even watch → watch needs fresh engines
  // (new videoId, possibly swapped player internals).
  adEngine?.stop()
  adEngine = null
  sponsorEngine?.stop()
  sponsorEngine = null
  // stop() flushes the final position before the videoId changes.
  resumeTracker?.stop()
  resumeTracker = null
  syncEngines()
}

function getPageStatus(): PageStatus {
  return {
    isWatchPage: isWatchPage(),
    adEngineActive: adEngine?.isActive ?? false,
    sponsorStatus: sponsorEngine?.status ?? 'off',
    sponsorReason: sponsorEngine?.reason,
    segmentCount: sponsorEngine?.segmentCount ?? 0,
    segments: sponsorEngine?.activeSegments ?? [],
    analyzingSince: sponsorEngine?.analyzingSince,
    progressDone: sponsorEngine?.progressDone,
    progressTotal: sponsorEngine?.progressTotal,
  }
}

async function main() {
  settings = await getSettings()
  onSettingsChanged((next) => {
    settings = next
    syncEngines()
  })

  // We're live on this YouTube tab — clear any "needs reload" badge that a
  // recent extension update left on it.
  chrome.runtime
    .sendMessage({ type: 'skipSensei:tabNeedsReload', needsReload: false })
    .catch(() => {})

  // YouTube fires this on every SPA navigation, including autoplay/next.
  document.addEventListener('yt-navigate-finish', onNavigate)

  // YouTube annoyance removers (Shorts, end cards, autoplay, idle prompt) —
  // each gated on its own setting; harmless when all are off.
  initYouTubeAnnoyances()

  chrome.runtime.onMessage.addListener(
    (message: TabMessage, _sender, sendResponse) => {
      if (message?.type === 'skipSensei:getPageStatus') {
        sendResponse(getPageStatus())
      } else if (message?.type === 'skipSensei:getResumePosition') {
        // Popup's cookie-clear button: where to pick the video back up after
        // the reload (0 when the engine is off or nothing has played yet, in
        // which case the popup just reloads).
        sendResponse(adEngine?.resumeSeconds() ?? 0)
      } else if (message?.type === 'skipSensei:analysisProgress') {
        log(`analyzing chunk ${message.done}/${message.total}`)
        sponsorEngine?.noteProgress(message.videoId, message.done, message.total)
      } else if (message?.type === 'skipSensei:reanalyzeSponsors') {
        void sponsorEngine?.reanalyze()
      }
    },
  )

  syncEngines()
}

void main()
