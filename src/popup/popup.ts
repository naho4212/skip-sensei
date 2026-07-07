import {
  getSettings,
  getStats,
  onStatsChanged,
  setSiteAllowlisted,
  updateSettings,
} from '../storage'
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
const blockAdsToggle = $<HTMLInputElement>('block-ads-toggle')
const blockerNoteEl = $('blocker-note')
const pauseSiteToggle = $<HTMLInputElement>('pause-site-toggle')
const videoStatusEl = $('video-status')
const segmentListEl = $<HTMLUListElement>('segment-list')
const reloadTabEl = $<HTMLButtonElement>('reload-tab')

function renderSettings(settings: Settings) {
  masterToggle.checked = settings.masterEnabled
  adToggle.checked = settings.adEngineEnabled
  sponsorToggle.checked = settings.sponsorEngineEnabled
  blockAdsToggle.checked = settings.blockAllAds
  document.body.classList.toggle('disabled', !settings.masterEnabled)
}

let currentHost: string | null = null

async function renderSiteSection() {
  const titleEl = $('site-section-title')
  const sectionEl = $('site-section')
  const settings = await getSettings()

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  let host: string | null = null
  try {
    const url = tab?.url ? new URL(tab.url) : null
    if (url && (url.protocol === 'http:' || url.protocol === 'https:')) {
      host = url.hostname
    }
  } catch {
    host = null
  }
  currentHost = host

  // Only relevant for the general "Block all ads" engine on a real web page.
  if (!settings.blockAllAds || !host) {
    titleEl.hidden = true
    sectionEl.hidden = true
    $('page-blocked').hidden = true
    return
  }
  titleEl.hidden = false
  sectionEl.hidden = false

  $('site-host').textContent = host
  const paused = settings.allowlist.includes(host)
  pauseSiteToggle.checked = paused

  // Page-blocked count lives in the "Skipped" section (under Sponsor segments).
  const pageBlockedEl = $('page-blocked')
  const pageBlockedCountEl = $('page-blocked-count')
  pageBlockedEl.hidden = false
  if (paused) {
    pageBlockedCountEl.textContent = '0'
    pageBlockedEl.lastChild!.textContent = ' ads blocked (paused here)'
  } else if (tab?.id !== undefined) {
    try {
      const { rulesMatchedInfo } =
        await chrome.declarativeNetRequest.getMatchedRules({ tabId: tab.id })
      pageBlockedCountEl.textContent = String(rulesMatchedInfo.length)
      pageBlockedEl.lastChild!.textContent = ' ads blocked on this page'
    } catch {
      pageBlockedEl.hidden = true
    }
  }
}

async function renderBlockerState() {
  try {
    const state: { enabled: boolean; active: boolean; error?: string } =
      await chrome.runtime.sendMessage({ type: 'skipSensei:getBlockerState' })
    if (state.error) {
      blockerNoteEl.textContent = `Couldn't enable ad blocking: ${state.error}`
      blockerNoteEl.className = 'blocker-note warn'
      blockerNoteEl.hidden = false
    } else if (state.enabled && state.active) {
      blockerNoteEl.textContent = 'Blocking ads across the web. Reload open tabs to apply.'
      blockerNoteEl.className = 'blocker-note'
      blockerNoteEl.hidden = false
    } else {
      blockerNoteEl.hidden = true
    }
  } catch {
    blockerNoteEl.hidden = true
  }
}

function renderStats(stats: Stats, session: SessionStats | null) {
  $('alltime-ad-skips').textContent = String(stats.allTimeAdSkips)
  $('alltime-sponsor-skips').textContent = String(stats.allTimeSponsorSkips)
  if (session) {
    $('session-ad-skips').textContent = String(session.sessionAdSkips)
    $('session-sponsor-skips').textContent = String(session.sessionSponsorSkips)
  }
}

function formatTime(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const rest = `${String(m).padStart(h > 0 ? 2 : 1, '0')}:${String(s % 60).padStart(2, '0')}`
  return h > 0 ? `${h}:${rest}` : rest
}

const TYPE_LABELS: Record<string, string> = {
  sponsor: 'sponsor',
  'self-promo': 'self-promo',
  'ad-read': 'ad read',
}

function renderProgress(status: PageStatus | null) {
  const wrap = $('analysis-progress')
  const bar = $('analysis-bar')
  if (!status || status.sponsorStatus !== 'analyzing') {
    wrap.hidden = true
    return
  }
  wrap.hidden = false
  if (status.progressTotal && status.progressTotal > 0) {
    bar.classList.remove('indeterminate')
    bar.style.width = `${Math.max(6, (100 * (status.progressDone ?? 0)) / status.progressTotal)}%`
  } else {
    // No chunk info yet (transcript still downloading, or single fast call).
    bar.classList.add('indeterminate')
    bar.style.width = '35%'
  }
}

function renderSegments(status: PageStatus) {
  segmentListEl.replaceChildren(
    ...status.segments.map((segment) => {
      const li = document.createElement('li')
      const range = document.createElement('span')
      range.textContent = `${formatTime(segment.start)} → ${formatTime(segment.end)}`
      const type = document.createElement('span')
      type.className = 'segment-type'
      type.textContent = TYPE_LABELS[segment.type] ?? segment.type
      li.append(range, type)
      return li
    }),
  )
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
    case 'analyzing': {
      const elapsed = status.analyzingSince
        ? ` · ${formatTime((Date.now() - status.analyzingSince) / 1000)}`
        : ''
      return `Analyzing transcript${status.sponsorReason ? ` (${status.sponsorReason})` : ''}…${elapsed}`
    }
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
  reloadTabEl.hidden = true
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
      segmentListEl.replaceChildren()
      renderProgress(null)
      return
    }
    const adText = status.adEngineActive
      ? 'Watching for ads.'
      : 'Ad skipping is off.'
    videoStatusEl.textContent = `${adText} ${sponsorStatusText(status)}`
    renderProgress(status)
    renderSegments(status)
  } catch {
    videoStatusEl.textContent = 'Reload the YouTube tab to activate.'
    reloadTabEl.hidden = false
    segmentListEl.replaceChildren()
    renderProgress(null)
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
  blockAdsToggle.addEventListener('change', async () => {
    renderSettings(await updateSettings({ blockAllAds: blockAdsToggle.checked }))
    // Give the service worker a moment to flip the rulesets, then report.
    setTimeout(() => {
      void renderBlockerState()
      void renderSiteSection()
    }, 300)
  })

  pauseSiteToggle.addEventListener('change', async () => {
    if (!currentHost) return
    await setSiteAllowlisted(currentHost, pauseSiteToggle.checked)
    void renderSiteSection()
  })

  $('open-options').addEventListener('click', (event) => {
    event.preventDefault()
    void chrome.runtime.openOptionsPage()
  })

  reloadTabEl.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (tab?.id) {
      await chrome.tabs.reload(tab.id)
      window.close()
    }
  })

  void renderVideoStatus()
  void renderBlockerState()
  void renderSiteSection()
  // Analysis finishes async while the popup is open; 1s keeps the elapsed
  // timer ticking smoothly, and the blocked-ads count fresh.
  setInterval(() => {
    void renderVideoStatus()
    void renderSiteSection()
  }, 1000)
}

void main()
