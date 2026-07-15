import { changesSince } from '../../src/changelog'
import { clearCookiesFor } from '../../src/cookies'
import {
  clearAdblockWall,
  clearYtBackoff,
  getAdblockWall,
  getKeyReminder,
  getLastSeenVersion,
  getSettings,
  getStats,
  getYtBackoff,
  onStatsChanged,
  setKeyReminder,
  setLastSeenVersion,
  setSiteAllowlisted,
  updateSettings,
} from '../../src/storage'
import { BLOCK_CATEGORY_LABELS } from '../../src/types'
import type {
  BlockBreakdown,
  HiddenElement,
  PageStatus,
  Settings,
  Stats,
  TabMessage,
} from '../../src/types'

const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T

// The cosmetic content script runs in every iframe (all_frames). A frameless
// sendMessage races all of them and resolves with whichever frame answers
// first — on iframe-heavy pages (weather.com) an empty ad frame wins and the
// popup paints "nothing hidden". Always talk to the top frame.
const TOP_FRAME = { frameId: 0 }

const masterToggle = $<HTMLInputElement>('master-toggle')
const adToggle = $<HTMLInputElement>('ad-engine-toggle')
const sponsorToggle = $<HTMLInputElement>('sponsor-engine-toggle')
const aggressiveToggle = $<HTMLInputElement>('aggressive-toggle')
const blockAdsToggle = $<HTMLInputElement>('block-ads-toggle')
const aiEnhancementsToggle = $<HTMLInputElement>('ai-enhancements-toggle')
const blockerNoteEl = $('blocker-note')
const pauseSiteToggle = $<HTMLInputElement>('pause-site-toggle')
const videoStatusEl = $('video-status')
const adStatusEl = $('ad-status')
const segmentListEl = $<HTMLUListElement>('segment-list')
const reloadTabEl = $<HTMLButtonElement>('reload-tab')

function renderSettings(settings: Settings) {
  masterToggle.checked = settings.masterEnabled
  adToggle.checked = settings.adEngineEnabled
  sponsorToggle.checked = settings.sponsorEngineEnabled
  aggressiveToggle.checked = settings.aggressivePruning
  blockAdsToggle.checked = settings.blockAllAds
  aiEnhancementsToggle.checked = settings.aiEnhancements
  for (const pill of document.querySelectorAll<HTMLButtonElement>('.pill')) {
    const key = pill.dataset.key as keyof Settings
    pill.classList.toggle('on', Boolean(settings[key]))
  }
  document.body.classList.toggle('disabled', !settings.masterEnabled)
  $('brand-status').textContent = settings.masterEnabled
    ? 'Zero interruptions.'
    : 'Paused'
}

/** "This site" / "Controls" views — plain show/hide, reset on every open. */
function selectTab(tab: 'site' | 'controls') {
  $('view-site').hidden = tab !== 'site'
  $('view-controls').hidden = tab !== 'controls'
  $('tab-site').classList.toggle('on', tab === 'site')
  $('tab-controls').classList.toggle('on', tab === 'controls')
}

/** Compact large counts so four stat cards fit (48,392 → 48.4K). */
function formatCount(n: number): string {
  if (n < 10000) return n.toLocaleString()
  return new Intl.NumberFormat('en', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(n)
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
  sectionEl.classList.toggle('paused', paused)
  $('site-status').textContent = paused ? 'Paused here' : 'Blocking active'

  const pageBlockedEl = $('page-blocked')
  const pageBreakdownEl = $('page-breakdown')
  if (paused) {
    pageBlockedEl.textContent = 'Tap the power button to resume'
    pageBreakdownEl.textContent = ''
  } else {
    // Same live counter the icon badge uses, so the two never disagree.
    let bd: BlockBreakdown | null = null
    if (tab?.id !== undefined) {
      bd = await chrome.runtime
        .sendMessage({ type: 'skipSensei:getTabBlocked', tabId: tab.id })
        .catch(() => null)
    }
    const total = bd ? BLOCK_CATEGORY_LABELS.reduce((s, [k]) => s + bd![k], 0) : 0
    pageBlockedEl.textContent = `${total} blocked here`
    // Per-type line: only the categories that actually blocked something.
    pageBreakdownEl.textContent =
      bd && total > 0
        ? BLOCK_CATEGORY_LABELS.filter(([k]) => bd![k] > 0)
            .map(([k, label]) => `${bd![k]} ${label}${bd![k] === 1 ? '' : 's'}`)
            .join(' · ')
        : ''
  }
}

async function pageHasLoadedAds(): Promise<boolean> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) return false
  try {
    return await chrome.tabs.sendMessage(
      tab.id,
      { type: 'skipSensei:pageHasAds' },
      TOP_FRAME,
    )
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
      // Never on YouTube: it's exempt from network blocking (video ads are
      // skipped by the ad engine, display ads are hidden), so "reload to clear"
      // is wrong advice — a reload won't remove a video ad.
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      })
      const onYouTube = Boolean(tab?.url?.includes('youtube.com'))
      const needsReload = !onYouTube && (await pageHasLoadedAds())
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

function renderStats(stats: Stats) {
  // YouTube card is one "interruptions handled on YouTube" figure: video
  // ad-skips + sponsor-skips + hidden display ads. They're tracked separately
  // (the "This video" section shows sponsor segments on their own).
  $('alltime-youtube').textContent = formatCount(
    stats.allTimeAdSkips + stats.allTimeSponsorSkips + stats.allTimeYtAdsHidden,
  )
  $('alltime-web-blocks').textContent = formatCount(stats.allTimeWebAdsBlocked)
  $('alltime-trackers').textContent = formatCount(stats.allTimeTrackersBlocked)
  $('alltime-cookies').textContent = formatCount(stats.allTimeCookiesBlocked)
  const today = stats.today
  $('today-youtube').textContent = String(
    today.adSkips + today.sponsorSkips + today.ytAdsHidden,
  )
  $('today-web-blocks').textContent = String(today.webAdsBlocked)
  $('today-trackers').textContent = String(today.trackersBlocked)
  $('today-cookies').textContent = String(today.cookiesBlocked)
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
async function reviewTabId(): Promise<number | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  // Only web pages have a content script to talk to.
  if (!tab?.id || !/^https?:/.test(tab.url ?? '')) return null
  return tab.id
}

// The active tab we're reviewing, cached once renderHiddenReview resolves it,
// so the collapse toggle can drive the on-page faint outline without re-querying.
let reviewTabIdCache: number | null = null

// The review list is an occasional tool, not a glanceable stat (and it pushes
// Share/coffee off-screen), so every popup open starts collapsed. The user
// expands it with the "Hidden ads here" button when they want to look; it
// isn't remembered across opens — reopening the popup always starts collapsed.
// While it's open, every hidden element on the page gets a faint purple outline
// (the hovered row gets the strong one); collapsing clears them.
function setHiddenCollapsed(collapsed: boolean) {
  $('hidden-body').hidden = collapsed
  $('hidden-chevron').textContent = collapsed ? '▸' : '▾'
  $('hidden-toggle').setAttribute('aria-expanded', String(!collapsed))
  if (reviewTabIdCache !== null && !collapsed)
    sendHighlightAll(reviewTabIdCache, true)
  else if (reviewTabIdCache !== null) sendHighlightAll(reviewTabIdCache, false)
}

async function renderHiddenReview() {
  const wrap = $('hidden-review')
  const tabId = await reviewTabId()
  reviewTabIdCache = tabId
  if (tabId === null) {
    wrap.hidden = true
    return
  }
  let items: HiddenElement[] = []
  try {
    items =
      (await chrome.tabs.sendMessage(
        tabId,
        { type: 'skipSensei:getHiddenElements' },
        TOP_FRAME,
      )) ?? []
  } catch {
    // content script not ready (tab loaded before an extension reload)
    wrap.hidden = true
    return
  }
  wrap.hidden = false
  paintHiddenItems(tabId, items)
  void renderFeedbackReset(tabId)
}

/**
 * Every 👎 is stored per-site and silently keeps that thing visible forever —
 * including feature rows like the slot collapser. Mistaken taps (👎-ing an ad
 * out of instinct) used to be unrecoverable; this row surfaces the count and
 * offers a one-tap undo.
 */
async function renderFeedbackReset(tabId: number) {
  const row = $('hidden-reset')
  let rejectedCount = 0
  try {
    const fb = await chrome.tabs.sendMessage(
      tabId,
      { type: 'skipSensei:getSiteFeedback' },
      TOP_FRAME,
    )
    rejectedCount = fb?.rejectedCount ?? 0
  } catch {
    /* content script not ready */
  }
  row.hidden = rejectedCount === 0
  if (rejectedCount > 0)
    $('hidden-reset-text').textContent =
      `${rejectedCount} “not an ad” choice${rejectedCount === 1 ? '' : 's'} saved for this site.`
}

function paintHiddenItems(tabId: number, items: HiddenElement[]) {
  const hiddenCount = items.filter((i) => !i.vetoed).length
  const badge = $('hidden-count')
  badge.textContent = String(hiddenCount)
  badge.hidden = hiddenCount === 0
  const list = $<HTMLUListElement>('hidden-list')
  list.replaceChildren(...items.map((item) => hiddenItemRow(tabId, item)))
  $('hidden-empty').hidden = items.length > 0
}

const SOURCE_TAG: Record<string, string> = {
  ai: 'AI',
  list: 'list',
  youtube: 'YT',
}

// Hovering a review row outlines the matching element(s) on the page.
// A port (not one-shot messages) so the content script can clear the
// highlight the instant the popup closes, even mid-hover.
let highlightPort: chrome.runtime.Port | null = null
let highlightPortTab: number | null = null

function postHighlight(
  tabId: number,
  msg: { selector?: string | null; all?: boolean },
) {
  try {
    if (!highlightPort || highlightPortTab !== tabId) {
      highlightPort = chrome.tabs.connect(tabId, {
        name: 'skipSensei:highlight',
        ...TOP_FRAME,
      })
      highlightPortTab = tabId
      highlightPort.onDisconnect.addListener(() => {
        highlightPort = null
        highlightPortTab = null
      })
    }
    highlightPort.postMessage(msg)
  } catch {
    highlightPort = null
    highlightPortTab = null
  }
}

// Strong single-element highlight for the row being hovered.
function sendHighlight(tabId: number, selector: string | null) {
  postHighlight(tabId, { selector })
}

// Faint outline over every hidden element while the list is open.
function sendHighlightAll(tabId: number, on: boolean) {
  postHighlight(tabId, { all: on })
}

function hiddenItemRow(tabId: number, item: HiddenElement): HTMLLIElement {
  const li = document.createElement('li')
  li.className = item.vetoed ? 'hidden-item vetoed' : 'hidden-item'
  li.addEventListener('mouseenter', () => sendHighlight(tabId, item.selector))
  li.addEventListener('mouseleave', () => sendHighlight(tabId, null))

  const info = document.createElement('div')
  info.className = 'hidden-info'
  const label = document.createElement('span')
  label.className = 'hidden-label'
  label.textContent = item.text || `<${item.tag}>`
  const meta = document.createElement('span')
  meta.className = 'hidden-meta'
  const src = document.createElement('span')
  src.className = `hidden-src src-${item.source}`
  src.textContent = SOURCE_TAG[item.source] ?? item.source
  const detail = document.createElement('span')
  detail.textContent = `${item.tag || '?'}${item.count > 1 ? ` ×${item.count}` : ''}`
  meta.append(src, detail)
  // "Why hide an empty box?" — because it was an ad slot whose ad we stopped
  // upstream. The chip answers that; the slot still counts as one blocked ad.
  if (item.filled === false && !item.vetoed && item.source !== 'youtube') {
    const empty = document.createElement('span')
    empty.className = 'hidden-src src-empty'
    empty.textContent = 'empty'
    empty.title =
      'This ad slot was empty — its ad was blocked before it could load. It still counts as one blocked ad.'
    meta.append(empty)
  }
  if (item.vetoed) {
    const kept = document.createElement('span')
    kept.className = 'hidden-src src-vetoed'
    kept.textContent = 'kept visible'
    kept.title =
      'Looks ad-like, but the AI wasn’t sure it’s an ad, so it stays visible. 👍 hides it here from now on.'
    meta.append(kept)
  }
  info.append(label, meta)

  const actions = document.createElement('div')
  actions.className = 'hidden-actions'
  const up = document.createElement('button')
  up.className = 'hidden-btn'
  up.textContent = '👍 Ad'
  up.title = item.vetoed
    ? 'It is an ad — hide it from now on'
    : 'Yes, this is an ad — keep it hidden'
  const down = document.createElement('button')
  down.className = 'hidden-btn'
  down.textContent = '👎 Not ad'
  down.title = item.vetoed
    ? 'Not an ad — never flag it here again'
    : 'Not an ad — show it and never hide it on this site'
  up.addEventListener('click', () => {
    void chrome.tabs
      .sendMessage(
        tabId,
        { type: 'skipSensei:confirmHiddenSelector', selector: item.selector },
        TOP_FRAME,
      )
      .catch(() => {})
    sendHighlight(tabId, null)
    li.classList.add('confirmed')
    up.disabled = true
    down.disabled = true
  })
  down.addEventListener('click', async () => {
    sendHighlight(tabId, null)
    li.remove()
    if ($<HTMLUListElement>('hidden-list').children.length === 0)
      $('hidden-empty').hidden = false
    try {
      await chrome.tabs.sendMessage(
        tabId,
        { type: 'skipSensei:rejectHiddenSelector', selector: item.selector },
        TOP_FRAME,
      )
    } catch {
      /* content script gone — nothing to record */
    }
    void renderFeedbackReset(tabId) // the new 👎 is now undoable
  })
  actions.append(up, down)

  li.append(info, actions)
  return li
}

/** Collapsed on every popup open, like the hidden-ads review — the segment
 * list is an occasional look, not a glanceable stat. */
let sponsorSegmentsExpanded = false

/** Short title for the sponsor detail row (+ whether there's a list to
 * expand). The old full-sentence status made the row the wordiest thing in
 * the popup; the count says the same thing in the hidden-ads style. */
function sponsorTitle(status: PageStatus): {
  title: string
  expandable: boolean
  count?: number
} {
  switch (status.sponsorStatus) {
    case 'ready':
      return status.segmentCount > 0
        ? {
            title: 'Sponsor segments',
            expandable: true,
            count: status.segmentCount,
          }
        : { title: 'No sponsor segments found', expandable: false }
    case 'analyzing': {
      const elapsed = status.analyzingSince
        ? ` · ${formatTime((Date.now() - status.analyzingSince) / 1000)}`
        : ''
      return { title: `Analyzing transcript…${elapsed}`, expandable: false }
    }
    case 'no-transcript':
      return { title: 'No transcript to scan', expandable: false }
    case 'unavailable':
      return { title: 'No sponsor scan for this video', expandable: false }
    case 'error':
      return { title: 'Sponsor analysis failed', expandable: false }
    case 'off':
      return { title: 'Sponsor skipping is off', expandable: false }
  }
}

/** Apply title + expand state to the sponsor detail row. */
function setSponsorRow(title: string, expandable: boolean, count = 0) {
  videoStatusEl.textContent = title
  const badge = $('sponsor-count')
  badge.textContent = String(count)
  badge.hidden = count === 0
  if (!expandable) sponsorSegmentsExpanded = false
  const chevron = $('sponsor-chevron')
  chevron.hidden = !expandable
  chevron.textContent = sponsorSegmentsExpanded ? '▾' : '▸'
  const toggle = $<HTMLButtonElement>('sponsor-toggle')
  toggle.disabled = !expandable
  toggle.setAttribute('aria-expanded', String(sponsorSegmentsExpanded))
  segmentListEl.hidden = !sponsorSegmentsExpanded
}

/**
 * Per-video status folded under each engine's own toggle row: the ad
 * engine's line under "Skip YouTube ads", the sponsor analysis (plus
 * progress + segments) under "Skip sponsor segments". Off a watch page both
 * stay hidden — the toggles alone say everything there is to say.
 */
async function renderVideoStatus() {
  reloadTabEl.hidden = true
  const adDetail = $('ad-detail')
  const sponsorDetail = $('sponsor-detail')
  const hideBoth = () => {
    adDetail.hidden = true
    sponsorDetail.hidden = true
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) {
    hideBoth()
    return
  }
  // On YouTube proper we have the full page status; on any other site the
  // detail only makes sense when the page actually embeds a YouTube video, so
  // ask the content script before showing it. Anything else stays hidden.
  if (!tab.url?.includes('youtube.com')) {
    const hasEmbed = await chrome.tabs
      .sendMessage(tab.id, { type: 'skipSensei:hasYouTubeEmbed' }, TOP_FRAME)
      .catch(() => false)
    if (!hasEmbed) {
      hideBoth()
      return
    }
    adDetail.hidden = true
    sponsorDetail.hidden = false
    setSponsorRow('Embedded YouTube video', false)
    segmentListEl.replaceChildren()
    renderProgress(null)
    return
  }
  const message: TabMessage = { type: 'skipSensei:getPageStatus' }
  try {
    const status: PageStatus = await chrome.tabs.sendMessage(
      tab.id,
      message,
      TOP_FRAME,
    )
    if (!status.isWatchPage) {
      hideBoth()
      segmentListEl.replaceChildren()
      renderProgress(null)
      return
    }
    adDetail.hidden = false
    adStatusEl.textContent = status.adEngineActive
      ? 'Watching this video for ads'
      : 'Ad skipping is off'
    sponsorDetail.hidden = false
    const { title, expandable, count } = sponsorTitle(status)
    setSponsorRow(title, expandable, count ?? 0)
    renderProgress(status)
    renderSegments(status)
  } catch {
    // Content script unreachable (installed/updated after this tab loaded).
    adDetail.hidden = false
    adStatusEl.textContent = 'Reload the YouTube tab to activate.'
    reloadTabEl.hidden = false
    sponsorDetail.hidden = true
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

/** Gemini-key reminder queued by onboarding's "Maybe later". Self-clears if
 * a key or non-builtin provider was configured in the meantime. */
async function renderKeyReminder() {
  if (!(await getKeyReminder())) return
  const settings = await getSettings()
  if (settings.llmProvider !== 'builtin' || settings.apiKeys.gemini) {
    void setKeyReminder(false)
    return
  }
  const banner = $('key-reminder')
  banner.hidden = false
  $('key-reminder-dismiss').addEventListener(
    'click',
    () => {
      banner.hidden = true
      void setKeyReminder(false)
    },
    { once: true },
  )
  $('key-reminder-open').addEventListener(
    'click',
    () => {
      void setKeyReminder(false)
      void chrome.runtime.openOptionsPage()
    },
    { once: true },
  )
}

async function renderYtBackoff() {
  const el = $('yt-backoff')
  const backoff = await getYtBackoff()
  // Show only while the notice is fresh (7 days) — the flag itself clears when
  // the user acts, this just stops a very old one lingering.
  const fresh = backoff && Date.now() - backoff.at < 7 * 24 * 60 * 60 * 1000
  el.hidden = !fresh
  if (!fresh && backoff) void clearYtBackoff()
}

// Clear youtube.com cookies to lift YouTube's ad-blocker-detection flag, then
// reload the active tab if it's YouTube. Cookies are scoped to youtube.com,
// which we already hold host permission for — nothing else is touched.
async function clearYouTubeCookiesAndReload(btn: HTMLButtonElement) {
  const original = btn.textContent
  btn.disabled = true
  btn.textContent = 'Clearing…'
  try {
    // `cookies` is an optional permission — request it on this click gesture.
    const granted = await chrome.permissions.request({ permissions: ['cookies'] })
    if (!granted) {
      btn.disabled = false
      btn.textContent = original
      return
    }
    await clearCookiesFor({ domain: 'youtube.com' })
    await clearYtBackoff()
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    let onYouTube = false
    try {
      onYouTube = !!tab?.url && /(^|\.)youtube\.com$/.test(new URL(tab.url).hostname)
    } catch {
      onYouTube = false
    }
    if (tab?.id !== undefined && onYouTube) await chrome.tabs.reload(tab.id)
    window.close()
  } catch {
    // Best effort — restore the button so the user can retry or act manually.
    btn.disabled = false
    btn.textContent = original
  }
}

// The active tab's hostname, or null for extension/internal pages.
async function activeTabHost(): Promise<{ host: string; url: string } | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.url) return null
  try {
    const u = new URL(tab.url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return { host: u.hostname, url: tab.url }
  } catch {
    return null
  }
}

// Show the "site detected your ad blocker" notice if the active tab's host has
// a recent wall record.
async function renderAdblockWall() {
  const el = $('adblock-wall')
  const active = await activeTabHost()
  const wall = active ? await getAdblockWall(active.host) : null
  el.hidden = !wall
  if (wall && active) {
    $('adblock-wall-site').textContent = active.host.replace(/^www\./, '')
  }
}

// Clear the active site's cookies to lift its ad-blocker wall, then reload.
// Clearing another origin's cookies needs host permission for it — which the
// base install doesn't hold — so request just that origin on demand (this runs
// from a click, a valid user gesture). Then clear cookies the page would send,
// drop the wall record, and reload.
async function clearSiteCookiesAndReload(
  btn: HTMLButtonElement,
  // Structured rows keep their markup and swap only this label element.
  label: HTMLElement = btn,
) {
  const original = label.textContent
  const active = await activeTabHost()
  if (!active) return
  btn.disabled = true
  label.textContent = 'Clearing…'
  try {
    const origin = new URL(active.url).origin
    const granted = await chrome.permissions.request({
      permissions: ['cookies'],
      origins: [`${origin}/*`],
    })
    if (!granted) {
      btn.disabled = false
      label.textContent = original
      return
    }
    await clearCookiesFor({ url: active.url })
    await clearAdblockWall(active.host)
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (tab?.id !== undefined) await chrome.tabs.reload(tab.id)
    window.close()
  } catch {
    btn.disabled = false
    label.textContent = original
  }
}

async function main() {
  void renderUpdateBanner()
  void renderKeyReminder()
  void renderYtBackoff()
  void renderAdblockWall()
  $('yt-backoff-dismiss').addEventListener('click', () => {
    $('yt-backoff').hidden = true
    void clearYtBackoff()
  })
  $('yt-backoff-clear').addEventListener('click', (e) => {
    void clearYouTubeCookiesAndReload(e.currentTarget as HTMLButtonElement)
  })
  $('adblock-wall-dismiss').addEventListener('click', () => {
    $('adblock-wall').hidden = true
    void activeTabHost().then((a) => a && clearAdblockWall(a.host))
  })
  $('adblock-wall-clear').addEventListener('click', (e) => {
    void clearSiteCookiesAndReload(e.currentTarget as HTMLButtonElement)
  })
  // Always-available "reset this site": clear cookies + reload. Only meaningful
  // on a real web page, so reveal it only when the active tab has an http(s) host.
  const resetSiteBtn = $<HTMLButtonElement>('reset-site-btn')
  void activeTabHost().then((active) => {
    resetSiteBtn.hidden = !active
  })
  resetSiteBtn.addEventListener('click', (e) => {
    void clearSiteCookiesAndReload(
      e.currentTarget as HTMLButtonElement,
      $('reset-site-label'),
    )
  })
  renderSettings(await getSettings())
  renderStats(await getStats())
  onStatsChanged(renderStats)

  $('tab-site').addEventListener('click', () => selectTab('site'))
  $('tab-controls').addEventListener('click', () => selectTab('controls'))

  // Granular web-blocking pills: each maps 1:1 to a settings key. The DNR
  // side works without the broad grant (the blockAds toggle owns that ask).
  for (const pill of document.querySelectorAll<HTMLButtonElement>('.pill')) {
    pill.addEventListener('click', async () => {
      const key = pill.dataset.key as
        | 'blockTrackers'
        | 'blockCookieNotices'
        | 'blockPopups'
        | 'blockSocial'
        | 'blockUrlTracking'
      const settings = await getSettings()
      renderSettings(await updateSettings({ [key]: !settings[key] }))
      setTimeout(() => {
        void renderBlockerState()
        void renderSiteSection()
      }, 300)
    })
  }

  wireToggle(masterToggle, 'masterEnabled')
  wireToggle(adToggle, 'adEngineEnabled')
  wireToggle(sponsorToggle, 'sponsorEngineEnabled')
  wireToggle(aggressiveToggle, 'aggressivePruning')
  wireToggle(aiEnhancementsToggle, 'aiEnhancements')
  blockAdsToggle.addEventListener('change', async () => {
    // Cosmetic hiding on the broad web needs the optional all-sites permission
    // (network/DNR blocking doesn't). Request it on this click gesture when the
    // user turns blocking on, so hiding empty ad slots/containers actually works
    // — otherwise "Block all ads" would only strip network requests and leave
    // husks behind. Declining still enables network blocking.
    if (blockAdsToggle.checked) {
      await chrome.permissions
        .request({ origins: ['*://*/*'] })
        .catch(() => false)
    }
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

  setHiddenCollapsed(true) // always start collapsed on open
  $('sponsor-toggle').addEventListener('click', () => {
    sponsorSegmentsExpanded = !sponsorSegmentsExpanded
    void renderVideoStatus()
  })
  $('hidden-toggle').addEventListener('click', () =>
    setHiddenCollapsed(!$('hidden-body').hidden),
  )

  const resetBtn = $<HTMLButtonElement>('hidden-reset-btn')
  resetBtn.addEventListener('click', async () => {
    const tabId = await reviewTabId()
    if (tabId === null) return
    resetBtn.disabled = true
    try {
      const items: HiddenElement[] =
        (await chrome.tabs.sendMessage(
          tabId,
          { type: 'skipSensei:resetSiteFeedback' },
          TOP_FRAME,
        )) ?? []
      paintHiddenItems(tabId, items)
      $('hidden-reset').hidden = true
    } catch {
      /* content script not ready */
    }
    resetBtn.disabled = false
  })

  const scanBtn = $<HTMLButtonElement>('scan-ads-btn')
  scanBtn.addEventListener('click', async () => {
    const tabId = await reviewTabId()
    if (tabId === null) return
    scanBtn.disabled = true
    scanBtn.textContent = 'Scanning…'
    try {
      const items: HiddenElement[] =
        (await chrome.tabs.sendMessage(
          tabId,
          { type: 'skipSensei:scanForAds' },
          TOP_FRAME,
        )) ?? []
      paintHiddenItems(tabId, items)
      setHiddenCollapsed(false) // show what the scan found
    } catch {
      /* content script not ready */
    }
    scanBtn.disabled = false
    scanBtn.textContent = 'Scan for ads'
  })
  // Analysis finishes async while the popup is open; 1s keeps the elapsed
  // timer ticking smoothly, and the blocked-ads count fresh.
  setInterval(() => {
    void renderVideoStatus()
    void renderSiteSection()
  }, 1000)
}

void main()
