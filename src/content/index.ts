import { getSettings, onSettingsChanged } from '../storage'
import type {
  AdSkipMethod,
  Message,
  PageStatus,
  Settings,
  TabMessage,
} from '../types'
import { AdEngine } from './ad-engine'
import { SponsorEngine } from './sponsor-engine'

/**
 * Content-script entry. Runs on all youtube.com pages (YouTube is an SPA, so
 * only the first page is a real load); gates engine lifecycle on watch pages
 * and re-initializes on yt-navigate-finish.
 */

let settings: Settings | null = null
let adEngine: AdEngine | null = null
let sponsorEngine: SponsorEngine | null = null

function isWatchPage(): boolean {
  return location.pathname === '/watch'
}

function getVideoId(): string | null {
  return new URLSearchParams(location.search).get('v')
}

function reportAdSkip(method: AdSkipMethod) {
  const message: Message = { type: 'skipSensei:adSkipped', method }
  // Service worker may be asleep mid-restart; a dropped count isn't worth a crash.
  chrome.runtime.sendMessage(message).catch(() => {})
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
  } else if (!adShouldRun && adEngine) {
    adEngine.stop()
    adEngine = null
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

  // YouTube fires this on every SPA navigation, including autoplay/next.
  document.addEventListener('yt-navigate-finish', onNavigate)

  chrome.runtime.onMessage.addListener(
    (message: TabMessage, _sender, sendResponse) => {
      if (message?.type === 'skipSensei:getPageStatus') {
        sendResponse(getPageStatus())
      } else if (message?.type === 'skipSensei:analysisProgress') {
        console.log(
          `[skipSensei] analyzing chunk ${message.done}/${message.total}`,
        )
        sponsorEngine?.noteProgress(message.videoId, message.done, message.total)
      }
    },
  )

  syncEngines()
}

void main()
