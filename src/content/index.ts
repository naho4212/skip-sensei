import { getSettings, onSettingsChanged } from '../storage'
import type {
  AdSkipMethod,
  Message,
  PageStatus,
  Settings,
  TabMessage,
} from '../types'
import { AdEngine } from './ad-engine'

/**
 * Content-script entry. Runs on all youtube.com pages (YouTube is an SPA, so
 * only the first page is a real load); gates engine lifecycle on watch pages
 * and re-initializes on yt-navigate-finish.
 */

let settings: Settings | null = null
let adEngine: AdEngine | null = null

function isWatchPage(): boolean {
  return location.pathname === '/watch'
}

function reportAdSkip(method: AdSkipMethod) {
  const message: Message = { type: 'skipSensei:adSkipped', method }
  // Service worker may be asleep mid-restart; a dropped count isn't worth a crash.
  chrome.runtime.sendMessage(message).catch(() => {})
}

function syncEngines() {
  const shouldRun =
    isWatchPage() &&
    settings !== null &&
    settings.masterEnabled &&
    settings.adEngineEnabled

  if (shouldRun && !adEngine) {
    adEngine = new AdEngine(reportAdSkip)
    adEngine.start()
  } else if (!shouldRun && adEngine) {
    adEngine.stop()
    adEngine = null
  }
}

function onNavigate() {
  // Tear down unconditionally: even watch → watch needs a fresh attach
  // because YouTube may swap player internals.
  adEngine?.stop()
  adEngine = null
  syncEngines()
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
        const status: PageStatus = {
          isWatchPage: isWatchPage(),
          adEngineActive: adEngine?.isActive ?? false,
        }
        sendResponse(status)
      }
    },
  )

  syncEngines()
}

void main()
