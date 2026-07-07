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
    sectionEl.hidden = true
    return
  }
  sectionEl.hidden = false

  $('site-host').textContent = host
  const paused = settings.allowlist.includes(host)
  pauseSiteToggle.checked = paused

  const pageBlockedEl = $('page-blocked')
  if (paused) {
    pageBlockedEl.textContent = 'paused'
  } else {
    // Same live counter the icon badge uses, so the two never disagree.
    let n = 0
    if (tab?.id !== undefined) {
      const count = await chrome.runtime
        .sendMessage({ type: 'skipSensei:getTabBlocked', tabId: tab.id })
        .catch(() => 0)
      n = typeof count === 'number' ? count : 0
    }
    pageBlockedEl.textContent = `${n} blocked here`
  }
}

async function pageHasLoadedAds(): Promise<boolean> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) return false
  try {
    return await chrome.tabs.sendMessage(tab.id, {
      type: 'skipSensei:pageHasAds',
    })
  } catch {
    return false
  }
}

async function renderBlockerState() {
  const textEl = $('blocker-note-text')
  const reloadBtn = $('blocker-reload')
  try {
    const state: { enabled: boolean; active: boolean; error?: string } =
      await chrome.runtime.sendMessage({ type: 'skipSensei:getBlockerState' })
    if (state.error) {
      textEl.textContent = `Couldn't enable ad blocking: ${state.error}`
      blockerNoteEl.className = 'blocker-note warn'
      blockerNoteEl.hidden = false
      reloadBtn.hidden = true
    } else if (state.enabled && state.active) {
      blockerNoteEl.className = 'blocker-note'
      blockerNoteEl.hidden = false
      // Only offer a reload when THIS page still has ads that loaded before
      // blocking — so we never nag (or risk losing work) when it's not needed.
      const needsReload = await pageHasLoadedAds()
      if (needsReload) {
        textEl.textContent = 'Ads loaded before blocking — reload to clear them.'
        reloadBtn.hidden = false
      } else {
        textEl.textContent = 'Blocking ads across the web.'
        reloadBtn.hidden = true
      }
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
  $('alltime-web-blocks').textContent = String(stats.allTimeWebAdsBlocked)
  if (session) {
    $('session-ad-skips').textContent = String(session.sessionAdSkips)
    $('session-sponsor-skips').textContent = String(session.sessionSponsorSkips)
    $('session-web-blocks').textContent = String(session.sessionWebAdsBlocked)
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
      return 'No transcript available — can’t scan for sponsor segments.'
    case 'unavailable':
      return status.sponsorReason
        ? `No sponsor scan — ${status.sponsorReason}.`
        : 'No sponsor scan for this video.'
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

  $('blocker-reload').addEventListener('click', async () => {
    // Only the current tab — reloading others could lose work in progress.
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (tab?.id) {
      await chrome.tabs.reload(tab.id)
      window.close()
    }
  })

  $('open-options').addEventListener('click', (event) => {
    event.preventDefault()
    void chrome.runtime.openOptionsPage()
  })

  const shareBtn = $<HTMLButtonElement>('share-btn')
  shareBtn.addEventListener('click', async () => {
    // Placeholder link — swap for the Chrome Web Store URL once published.
    const shareUrl = '' // TODO: store listing URL
    const shareText =
      'Skip YouTube ads & creator sponsor segments, and block ads across the web with Ad Sensei.'
    const nav = navigator as Navigator & {
      share?: (data: ShareData) => Promise<void>
    }
    if (nav.share) {
      try {
        await nav.share({ title: 'Ad Sensei', text: shareText, url: shareUrl })
        return
      } catch {
        // user cancelled or share unavailable — fall through to copy
      }
    }
    try {
      await navigator.clipboard.writeText(
        shareUrl ? `${shareText} ${shareUrl}` : shareText,
      )
      const original = shareBtn.textContent
      shareBtn.textContent = '✓ Copied'
      setTimeout(() => (shareBtn.textContent = original), 1500)
    } catch {
      // clipboard blocked — nothing more to do
    }
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
