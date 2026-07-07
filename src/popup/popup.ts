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

function sponsorStatusText(status: PageStatus): string {
  const plural = (n: number) => (n === 1 ? 'segment' : 'segments')
  switch (status.sponsorStatus) {
    case 'ready':
      return status.segmentCount > 0
        ? `Transcript analyzed — ${status.segmentCount} sponsor ${plural(status.segmentCount)} found.`
        : 'Transcript analyzed — no sponsor segments found.'
    case 'analyzing':
      return `Analyzing transcript${status.sponsorReason ? ` (${status.sponsorReason})` : ''}…`
    case 'no-transcript':
      return 'No transcript available — sponsor skipping off for this video.'
    case 'unavailable':
      return status.sponsorReason ?? 'Sponsor skipping unavailable for this video.'
    case 'error':
      return `Sponsor analysis failed${status.sponsorReason ? `: ${status.sponsorReason}` : ''}`
    case 'off':
      return 'Sponsor skipping is off.'
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
      return
    }
    const adText = status.adEngineActive
      ? 'Watching for ads.'
      : 'Ad skipping is off.'
    videoStatusEl.textContent = `${adText} ${sponsorStatusText(status)}`
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

  $('open-options').addEventListener('click', (event) => {
    event.preventDefault()
    void chrome.runtime.openOptionsPage()
  })

  void renderVideoStatus()
  // Analysis finishes async while the popup is open; keep the status fresh.
  setInterval(renderVideoStatus, 1500)
}

void main()
