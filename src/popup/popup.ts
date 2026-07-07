import { getSettings, getStats, onStatsChanged, updateSettings } from '../storage'
import type {
  Message,
  PageStatus,
  SessionStats,
  Settings,
  Stats,
  TabMessage,
} from '../types'

const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T

const masterToggle = $<HTMLInputElement>('master-toggle')
const adToggle = $<HTMLInputElement>('ad-engine-toggle')
const sponsorToggle = $<HTMLInputElement>('sponsor-engine-toggle')
const sessionSkipsEl = $('session-skips')
const allTimeSkipsEl = $('alltime-skips')
const videoStatusEl = $('video-status')

function renderSettings(settings: Settings) {
  masterToggle.checked = settings.masterEnabled
  adToggle.checked = settings.adEngineEnabled
  sponsorToggle.checked = settings.sponsorEngineEnabled
  document.body.classList.toggle('disabled', !settings.masterEnabled)
}

function renderStats(stats: Stats, session: SessionStats | null) {
  allTimeSkipsEl.textContent = String(
    stats.allTimeAdSkips + stats.allTimeSponsorSkips,
  )
  if (session) {
    sessionSkipsEl.textContent = String(
      session.sessionAdSkips + session.sessionSponsorSkips,
    )
  }
}

async function fetchSessionStats(): Promise<SessionStats | null> {
  const message: Message = { type: 'skipSensei:getSessionStats' }
  try {
    return await chrome.runtime.sendMessage(message)
  } catch {
    return null
  }
}

async function renderVideoStatus() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id || !tab.url?.includes('youtube.com')) {
    videoStatusEl.textContent = 'Open a YouTube video to start skipping.'
    return
  }
  const message: TabMessage = { type: 'skipSensei:getPageStatus' }
  try {
    const status: PageStatus = await chrome.tabs.sendMessage(tab.id, message)
    if (!status.isWatchPage) {
      videoStatusEl.textContent = 'Not watching a video.'
    } else if (status.adEngineActive) {
      videoStatusEl.textContent = 'Watching for ads on this video.'
    } else {
      videoStatusEl.textContent = 'Ad skipping is off for this video.'
    }
  } catch {
    videoStatusEl.textContent = 'Reload the YouTube tab to activate.'
  }
}

function wireToggle(input: HTMLInputElement, key: keyof Settings) {
  input.addEventListener('change', async () => {
    renderSettings(await updateSettings({ [key]: input.checked }))
    void renderVideoStatus()
  })
}

async function main() {
  renderSettings(await getSettings())
  renderStats(await getStats(), await fetchSessionStats())
  onStatsChanged((stats) => {
    void fetchSessionStats().then((session) => renderStats(stats, session))
  })

  wireToggle(masterToggle, 'masterEnabled')
  wireToggle(adToggle, 'adEngineEnabled')
  wireToggle(sponsorToggle, 'sponsorEngineEnabled')

  void renderVideoStatus()
}

void main()
