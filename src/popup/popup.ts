import { changesSince } from '../changelog'
import {
  getLastSeenVersion,
  getSettings,
  getStats,
  onStatsChanged,
  setLastSeenVersion,
  setSiteAllowlisted,
  updateSettings,
} from '../storage'
import type {
  HiddenElement,
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
      // Only surface the note when THIS page still has ads that loaded before
      // blocking — otherwise stay quiet (the ⓘ tooltip explains the feature).
      const needsReload = await pageHasLoadedAds()
      if (needsReload) {
        blockerNoteEl.className = 'blocker-note'
        textEl.textContent = 'Ads loaded before blocking — reload to clear them.'
        reloadBtn.hidden = false
        blockerNoteEl.hidden = false
      } else {
        blockerNoteEl.hidden = true
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
  interaction: 'reminder',
  intro: 'intro',
  outro: 'outro',
  preview: 'preview',
  filler: 'filler',
  'music-offtopic': 'off-topic',
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

/** Where a segment came from → short badge label + title. */
const SOURCE_LABELS: Record<string, { label: string; title: string }> = {
  sponsorblock: { label: 'SB', title: 'SponsorBlock (community database)' },
  llm: { label: 'AI', title: 'AI transcript analysis' },
  chapter: { label: 'chapter', title: 'Creator “Ad Break” chapter' },
}

function renderSegments(status: PageStatus) {
  segmentListEl.replaceChildren(
    ...status.segments.map((segment) => {
      const li = document.createElement('li')
      const range = document.createElement('span')
      range.textContent = `${formatTime(segment.start)} → ${formatTime(segment.end)}`

      const meta = document.createElement('span')
      meta.className = 'seg-meta'
      const src = SOURCE_LABELS[segment.source ?? 'llm']
      if (src) {
        const badge = document.createElement('span')
        badge.className = `segment-src src-${segment.source ?? 'llm'}`
        badge.textContent = src.label
        badge.title = src.title
        meta.append(badge)
      }
      const type = document.createElement('span')
      type.className = 'segment-type'
      type.textContent = TYPE_LABELS[segment.type] ?? segment.type
      meta.append(type)

      li.append(range, meta)
      return li
    }),
  )
}

/**
 * Feedback loop: show what the AI gap-filler hid on this site so it can be
 * reviewed. 👎 un-hides it and blocks it here for good; 👍 confirms it. Both
 * feed the anonymous gapfill_feedback diagnostics.
 */
async function renderHiddenReview() {
  const wrap = $('hidden-review')
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  let items: HiddenElement[] = []
  if (tab?.id) {
    try {
      items =
        (await chrome.tabs.sendMessage(tab.id, {
          type: 'skipSensei:getHiddenElements',
        })) ?? []
    } catch {
      items = []
    }
  }
  if (!tab?.id || items.length === 0) {
    wrap.hidden = true
    return
  }
  wrap.hidden = false
  $('hidden-title').textContent = `Hidden by AI here (${items.length})`
  const list = $<HTMLUListElement>('hidden-list')
  list.replaceChildren(...items.map((item) => hiddenItemRow(tab.id!, item)))
}

function hiddenItemRow(tabId: number, item: HiddenElement): HTMLLIElement {
  const li = document.createElement('li')
  li.className = 'hidden-item'

  const info = document.createElement('div')
  info.className = 'hidden-info'
  const label = document.createElement('span')
  label.className = 'hidden-label'
  label.textContent = item.text || `<${item.tag}>`
  const meta = document.createElement('span')
  meta.className = 'hidden-meta'
  meta.textContent = `${item.tag || '?'}${item.count > 1 ? ` ×${item.count}` : ''}`
  info.append(label, meta)

  const actions = document.createElement('div')
  actions.className = 'hidden-actions'
  const up = document.createElement('button')
  up.className = 'hidden-btn'
  up.textContent = '👍'
  up.title = 'Yes, this is an ad'
  const down = document.createElement('button')
  down.className = 'hidden-btn'
  down.textContent = '👎'
  down.title = 'Not an ad — un-hide and never hide here'
  up.addEventListener('click', () => {
    void chrome.tabs
      .sendMessage(tabId, {
        type: 'skipSensei:confirmHiddenSelector',
        selector: item.selector,
      })
      .catch(() => {})
    li.classList.add('confirmed')
    up.disabled = true
    down.disabled = true
  })
  down.addEventListener('click', () => {
    void chrome.tabs
      .sendMessage(tabId, {
        type: 'skipSensei:rejectHiddenSelector',
        selector: item.selector,
      })
      .catch(() => {})
    li.remove()
    if ($<HTMLUListElement>('hidden-list').children.length === 0)
      $('hidden-review').hidden = true
  })
  actions.append(up, down)

  li.append(info, actions)
  return li
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

/**
 * "What's new" banner. Triggered purely by a version change — no dependency
 * on onInstalled firing — so it works for Web Store auto-updates and manual
 * ZIP reloads alike. First run adopts the current version silently (no
 * changelog for the version that introduced changelogs).
 */
async function renderUpdateBanner() {
  const current = chrome.runtime.getManifest().version
  const lastSeen = await getLastSeenVersion()

  if (lastSeen === undefined || lastSeen === current) {
    if (lastSeen === undefined) await setLastSeenVersion(current)
    return
  }

  const entries = changesSince(lastSeen)
  if (entries.length === 0) {
    // Updated, but nothing user-facing was logged — adopt silently.
    await setLastSeenVersion(current)
    return
  }

  $('update-title').textContent =
    entries.length === 1
      ? `What's new in ${entries[0].version}`
      : "What's new"
  $<HTMLUListElement>('update-list').replaceChildren(
    ...entries
      .flatMap((entry) => entry.items)
      .map((item) => {
        const li = document.createElement('li')
        li.textContent = item
        return li
      }),
  )
  const banner = $('update-banner')
  banner.hidden = false
  $('update-dismiss').addEventListener(
    'click',
    () => {
      banner.hidden = true
      void setLastSeenVersion(current)
    },
    { once: true },
  )
}

async function main() {
  void renderUpdateBanner()
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

  // Only ever the current tab — reloading others could lose work in progress.
  const reloadActiveTab = async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (tab?.id) {
      await chrome.tabs.reload(tab.id)
      window.close()
    }
  }
  $('blocker-reload').addEventListener('click', () => void reloadActiveTab())
  $('reload-page').addEventListener('click', () => void reloadActiveTab())

  $('open-options').addEventListener('click', (event) => {
    event.preventDefault()
    void chrome.runtime.openOptionsPage()
  })

  // Clicking an ⓘ shouldn't toggle the switch it sits inside — hover only.
  document.querySelectorAll('.info').forEach((el) =>
    el.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
    }),
  )

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

  reloadTabEl.addEventListener('click', () => void reloadActiveTab())

  void renderVideoStatus()
  void renderBlockerState()
  void renderSiteSection()
  void renderHiddenReview()
  // Analysis finishes async while the popup is open; 1s keeps the elapsed
  // timer ticking smoothly, and the blocked-ads count fresh.
  setInterval(() => {
    void renderVideoStatus()
    void renderSiteSection()
  }, 1000)
}

void main()
