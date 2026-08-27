import { changesSince } from '../../src/changelog'
import { clearCookiesFor } from '../../src/cookies'
import { withResumeTime } from '../../src/resume'
import {
  clearAdblockWall,
  clearYtBackoff,
  getAdblockWall,
  finishReviewNudge,
  getKeyReminder,
  getLastSeenVersion,
  getReviewNudge,
  getSettings,
  getStats,
  getYtBackoff,
  onStatsChanged,
  resetStats,
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
  TodayStats,
} from '../../src/types'

/** Chrome Web Store listing — what the Share row hands to the OS share
 * sheet / clipboard. utm_source distinguishes popup shares from landing-page
 * clicks (utm_source=sfm). */
const SHARE_URL =
  'https://chromewebstore.google.com/detail/mjdcndkalddmlahidjabnncicdmpimmi?utm_source=share'
const REVIEW_URL =
  'https://chromewebstore.google.com/detail/mjdcndkalddmlahidjabnncicdmpimmi/reviews?utm_source=nudge'

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
const pauseSiteToggle = $<HTMLInputElement>('pause-site-toggle')
const videoStatusEl = $('video-status')
const adStatusEl = $('ad-status')
const segmentListEl = $<HTMLUListElement>('segment-list')
const reloadTabEl = $<HTMLButtonElement>('reload-tab')

/** Boolean settings exposed as plain rows in the Controls sections. Each
 * `opt-<key>` checkbox maps 1:1 to the settings key; the five web-block
 * lists used to be pills, the YouTube tidy-ups and the Spotify muter used
 * to live only on the options page. */
const OPT_KEYS = [
  'blockTrackers',
  'blockCookieNotices',
  'blockPopups',
  'blockSocial',
  'blockUrlTracking',
  'blockMalware',
  'defuseAntiAdblock',
  'ytHideShorts',
  'ytDismissStillWatching',
  'ytDisableEndCards',
  'resumePlayback',
  'showSkipToast',
  'muteAudioAds',
  'spotifySkipAds',
] as const satisfies readonly (keyof Settings)[]
type OptKey = (typeof OPT_KEYS)[number]

/** Keys whose change flips DNR rulesets in the service worker — give it a
 * moment before re-reading the blocker state and the page count. */
const RULESET_KEYS: ReadonlySet<string> = new Set([
  'blockAllAds',
  'blockTrackers',
  'blockCookieNotices',
  'blockPopups',
  'blockSocial',
  'blockUrlTracking',
  'blockMalware',
])

function renderSettings(settings: Settings) {
  masterToggle.checked = settings.masterEnabled
  adToggle.checked = settings.adEngineEnabled
  sponsorToggle.checked = settings.sponsorEngineEnabled
  aggressiveToggle.checked = settings.aggressivePruning
  blockAdsToggle.checked = settings.blockAllAds
  aiEnhancementsToggle.checked = settings.aiEnhancements
  for (const key of OPT_KEYS) {
    const el = document.getElementById(`opt-${key}`) as HTMLInputElement | null
    if (el) el.checked = Boolean(settings[key])
  }
  // Section masters: dependent rows dim (state kept) when the master is off.
  $('sec-adblock').classList.toggle('master-off', !settings.blockAllAds)
  $('sec-spotify').classList.toggle('master-off', !settings.blockAllAds)
  document.body.classList.toggle('disabled', !settings.masterEnabled)
  $('brand-status').textContent = settings.masterEnabled
    ? 'Zero interruptions.'
    : 'Paused'
  renderSectionStates(settings)
  if (!settings.masterEnabled) {
    setStatus('off', 'Ad Sensei is paused', 'Flip the switch above to resume.')
  } else if (statusState.kind === 'off') {
    void renderStatus()
  }
}

/** "3 of 9 on" summary on each collapsed section head. */
function renderSectionStates(settings: Settings) {
  for (const sec of document.querySelectorAll<HTMLElement>('.ctl-section')) {
    const inputs = sec.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
    const on = Array.from(inputs).filter((i) => i.checked).length
    const el = sec.querySelector<HTMLElement>('.ctl-section-state')
    if (el) el.textContent = `${on} of ${inputs.length} on`
  }
  void settings
}

/* ── Views ──────────────────────────────────────────────────────────── */
type View = 'home' | 'controls' | 'stats' | 'settings'
const VIEWS: View[] = ['home', 'controls', 'stats', 'settings']

/** Bottom tab bar: real tablist semantics (aria-selected + roving tabindex).
 * Every open starts on Home — the page-specific view. */
function selectView(view: View) {
  for (const v of VIEWS) {
    $(`view-${v}`).hidden = v !== view
    const btn = $<HTMLButtonElement>(`tab-${v}`)
    const active = v === view
    btn.classList.toggle('on', active)
    btn.setAttribute('aria-selected', String(active))
    btn.tabIndex = active ? 0 : -1
  }
  $('view-wrap-scroll')?.scrollTo(0, 0)
  document.querySelector('.view-wrap')?.scrollTo(0, 0)
}

/** True when `url`'s HOST is youtube.com — never a substring test on the full
 * URL, which matched paths/queries like /article-about-youtube.com-adblock. */
function isYouTubeUrl(url: string | undefined): boolean {
  try {
    return /(^|\.)youtube\.com$/.test(new URL(url ?? '').hostname)
  } catch {
    return false
  }
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

/* ── Status strip ───────────────────────────────────────────────────── */
type StatusKind = 'ok' | 'warn' | 'wall' | 'off'
interface StatusView {
  kind: StatusKind
  title: string
  text?: string
  action?: { label: string; run: (btn: HTMLButtonElement) => void }
  dismiss?: () => void
}
let statusState: StatusView = { kind: 'ok', title: "Everything's working" }

function setStatus(
  kind: StatusKind,
  title: string,
  text?: string,
  action?: StatusView['action'],
  dismiss?: () => void,
) {
  statusState = { kind, title, text, action, dismiss }
  paintStatus()
}

function paintStatus() {
  const el = $('status')
  el.dataset.state = statusState.kind
  $('status-title').textContent = statusState.title
  const text = $('status-text')
  text.hidden = !statusState.text
  text.textContent = statusState.text ?? ''
  const btn = $<HTMLButtonElement>('status-action')
  btn.hidden = !statusState.action
  btn.disabled = false
  btn.textContent = statusState.action?.label ?? ''
  btn.onclick = statusState.action
    ? () => statusState.action?.run(btn)
    : null
  const dismiss = $<HTMLButtonElement>('status-dismiss')
  dismiss.hidden = !statusState.dismiss
  dismiss.onclick = statusState.dismiss
    ? () => {
        statusState.dismiss?.()
        void renderStatus()
      }
    : null
}

/**
 * One strip, highest-priority state wins:
 *   wall  — the active site (or YouTube) showed an ad-blocker wall
 *   warn  — YouTube back-off notice, filter-list load failure, or ads that
 *           loaded before blocking (reload to clear)
 *   ok    — nothing to report
 * Replaces the old stack of yt-backoff / adblock-wall / blocker-note cards.
 */
async function renderStatus() {
  const settings = await getSettings()
  if (!settings.masterEnabled) {
    setStatus('off', 'Ad Sensei is paused', 'Flip the switch above to resume.')
    return
  }
  const active = await activeTabHost()

  // 1. Site wall on the active tab.
  const wall = active ? await getAdblockWall(active.host) : null
  if (wall && active) {
    const site = active.host.replace(/^www\./, '')
    setStatus(
      'wall',
      `${site} asked you to turn off your ad blocker`,
      "Some sites gate content behind an ad-blocker notice. Clearing this site's cookies usually restores access — or reload after signing out.",
      {
        label: "Clear this site's cookies & reload",
        run: (btn) => void clearSiteCookiesAndReload(btn),
      },
      () => void clearAdblockWall(active.host),
    )
    return
  }

  // 2. YouTube back-off (fresh within 7 days).
  const backoff = await getYtBackoff()
  const fresh = backoff && Date.now() - backoff.at < 7 * 24 * 60 * 60 * 1000
  if (!fresh && backoff) void clearYtBackoff()
  if (fresh) {
    setStatus(
      'warn',
      'YouTube showed an ad-blocker notice',
      'Experimental first-party blocking was turned off automatically. Ads are still skipped normally. If the notice sticks around, clearing YouTube\'s cookies usually clears it — or sign out and back in.',
      {
        label: 'Clear YouTube cookies & reload',
        run: (btn) => void clearYouTubeCookiesAndReload(btn),
      },
      () => void clearYtBackoff(),
    )
    return
  }

  // 3. Blocker health.
  try {
    const state: { enabled: boolean; active: boolean; error?: string } =
      await chrome.runtime.sendMessage({ type: 'skipSensei:getBlockerState' })
    if (state.error) {
      // The rule-count-limit failure is Chrome holding a stale static-rule
      // allocation (or another blocker using the shared pool); nothing the
      // extension retries can fix it, a browser restart can.
      const poolLimit = /rule count limit/i.test(state.error)
      setStatus(
        'warn',
        poolLimit ? "Some filter lists didn't load" : "Couldn't enable ad blocking",
        poolLimit
          ? "Chrome's rule budget is full (usually another ad blocker, or a stale allocation after an update). Restart Chrome; if it persists, disable the other blocker."
          : state.error,
      )
      return
    }
    if (state.enabled && state.active && active && !isYouTubeUrl(active.url)) {
      // Only when THIS page still has ads that loaded before blocking. Never
      // on YouTube: it's exempt from network blocking, a reload won't remove
      // a video ad.
      if (await pageHasLoadedAds()) {
        setStatus(
          'warn',
          'Ads loaded before blocking',
          'Reload this page to clear them.',
          { label: 'Reload page', run: () => void reloadActiveTab() },
        )
        return
      }
    }
  } catch {
    /* SW asleep — fall through to ok */
  }

  const onYouTube = isYouTubeUrl(active?.url)
  setStatus(
    'ok',
    onYouTube ? 'Watching for ads on YouTube' : "Everything's working",
  )
}

/* ── Site hero ──────────────────────────────────────────────────────── */
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

  const numEl = $('page-blocked-num')
  const labelEl = $('page-blocked-label')
  const pageBreakdownEl = $('page-breakdown')
  if (paused) {
    numEl.textContent = '—'
    labelEl.textContent = 'Tap the power button to resume'
    pageBreakdownEl.textContent = ''
  } else {
    // Same live counter the icon badge uses, so the two never disagree.
    let bd: BlockBreakdown | null = null
    if (tab?.id !== undefined) {
      bd = await chrome.runtime
        .sendMessage({ type: 'skipSensei:getTabBlocked', tabId: tab.id })
        .catch(() => null)
    }
    // null = the live recount was throttled (getMatchedRules quota) or the SW
    // didn't answer — KEEP the last shown value per the net-blocker contract;
    // overwriting with "0 blocked here" was a lie the popup used to tell.
    if (bd) {
      const total = BLOCK_CATEGORY_LABELS.reduce((s, [k]) => s + bd![k], 0)
      numEl.textContent = total.toLocaleString()
      labelEl.textContent = total === 1 ? 'ad blocked on this page' : 'ads blocked on this page'
      // Per-type line: only the categories that actually blocked something.
      pageBreakdownEl.textContent =
        total > 0
          ? BLOCK_CATEGORY_LABELS.filter(([k]) => bd![k] > 0)
              .map(([k, label]) => `${bd![k]} ${label}${bd![k] === 1 ? '' : 's'}`)
              .join(' · ')
          : ''
    } else if (numEl.textContent === '' || numEl.textContent === '—') {
      numEl.textContent = '—' // first paint, no data yet
      labelEl.textContent = 'blocked on this page'
    }
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

/* ── Stats ──────────────────────────────────────────────────────────── */
type Range = 'today' | '7' | '30' | 'all'
let statsRange: Range = 'today'
let lastStats: Stats | null = null

interface Bucket {
  youtube: number
  web: number
  trackers: number
  cookies: number
}

function bucketOf(d: TodayStats): Bucket {
  return {
    youtube: d.adSkips + d.sponsorSkips + d.ytAdsHidden,
    web: d.webAdsBlocked,
    trackers: d.trackersBlocked,
    cookies: d.cookiesBlocked,
  }
}
function add(a: Bucket, b: Bucket): Bucket {
  return {
    youtube: a.youtube + b.youtube,
    web: a.web + b.web,
    trackers: a.trackers + b.trackers,
    cookies: a.cookies + b.cookies,
  }
}

/** Local "YYYY-MM-DD" for `daysAgo` days before today. */
function dayKey(daysAgo: number): string {
  const d = new Date()
  d.setDate(d.getDate() - daysAgo)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function bucketForRange(stats: Stats, range: Range): Bucket {
  if (range === 'all')
    return {
      youtube:
        stats.allTimeAdSkips + stats.allTimeSponsorSkips + stats.allTimeYtAdsHidden,
      web: stats.allTimeWebAdsBlocked,
      trackers: stats.allTimeTrackersBlocked,
      cookies: stats.allTimeCookiesBlocked,
    }
  let b = bucketOf(stats.today)
  if (range === 'today') return b
  const days = Number(range)
  const floor = dayKey(days - 1) // inclusive: today counts as day 1
  for (const d of stats.history ?? []) {
    if (d.date >= floor && d.date !== stats.today.date) b = add(b, bucketOf(d))
  }
  return b
}

const RANGE_LABEL: Record<Range, string> = {
  today: 'today',
  '7': 'in the last 7 days',
  '30': 'in the last 30 days',
  all: 'all time',
}

function renderStats(stats: Stats) {
  lastStats = stats
  const b = bucketForRange(stats, statsRange)
  const total = b.youtube + b.web + b.trackers + b.cookies
  $('stat-total').textContent = formatCount(total)
  $('stat-total-label').textContent = `interruption${total === 1 ? '' : 's'} stopped ${RANGE_LABEL[statsRange]}`
  $('stat-youtube').textContent = formatCount(b.youtube)
  $('stat-web').textContent = formatCount(b.web)
  $('stat-trackers').textContent = formatCount(b.trackers)
  $('stat-cookies').textContent = formatCount(b.cookies)
  // Honest footnote: ranges only cover days recorded since this version.
  const note = $('stat-note')
  if (statsRange === '7' || statsRange === '30') {
    const days = (stats.history ?? []).filter((d) => d.date >= dayKey(Number(statsRange) - 1)).length + 1
    note.textContent =
      days < Number(statsRange)
        ? `Daily history started ${days === 1 ? 'today' : `${days} days ago`} — earlier activity is only in All time.`
        : ''
  } else {
    note.textContent = ''
  }
  // Home's compact line.
  const all = bucketForRange(stats, 'all')
  const today = bucketOf(stats.today)
  $('home-stats-num').textContent = formatCount(all.youtube + all.web + all.trackers + all.cookies)
  $('home-stats-today').textContent = formatCount(today.youtube + today.web + today.trackers + today.cookies)
}

function selectRange(range: Range) {
  statsRange = range
  for (const btn of document.querySelectorAll<HTMLButtonElement>('.seg-btn[data-range]')) {
    const on = btn.dataset.range === range
    btn.classList.toggle('on', on)
    btn.setAttribute('aria-selected', String(on))
  }
  if (lastStats) renderStats(lastStats)
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
    const pct = (100 * (status.progressDone ?? 0)) / status.progressTotal
    bar.style.width = `${Math.max(6, pct)}%`
    wrap.setAttribute('aria-valuenow', String(Math.round(pct)))
  } else {
    // No chunk info yet (transcript still downloading, or single fast call).
    // Indeterminate = no aria-valuenow, per the progressbar pattern.
    bar.classList.add('indeterminate')
    bar.style.width = '35%'
    wrap.removeAttribute('aria-valuenow')
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
  // Keyboard parity: tabbing onto a row's 👍/👎 buttons outlines the element
  // on the page just like hovering does (focusin/out bubble from the buttons).
  li.addEventListener('focusin', () => sendHighlight(tabId, item.selector))
  li.addEventListener('focusout', () => sendHighlight(tabId, null))

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
  if (!isYouTubeUrl(tab.url)) {
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
    $('sponsor-reanalyze').hidden = true
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
    // Re-analyze (↻) is offered once a pass has settled to a result the user
    // might want to redo — segments found, none found, or a failure — and
    // spins (disabled) while a pass is running. Hidden where a retry can't
    // change the outcome (no transcript, live/too-short, feature off).
    const reBtn = $<HTMLButtonElement>('sponsor-reanalyze')
    const s = status.sponsorStatus
    const offerReanalyze = s === 'ready' || s === 'error' || s === 'analyzing'
    reBtn.hidden = !offerReanalyze
    reBtn.disabled = s === 'analyzing'
    reBtn.classList.toggle('spinning', s === 'analyzing')
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

/** Fire-and-forget UI-usage counter bump, routed through the service worker
 * so its single storage chain serializes all writers (this page's own module
 * instance would race the SW's otherwise). Counts use of Ad Sensei's OWN
 * controls only — never anything about the page. Rides the same telemetry
 * consent as diagnostics (telemetryEnabled gates the rollup send). */
function usage(counter: string) {
  void chrome.runtime
    .sendMessage({ type: 'skipSensei:uiUsage', counter })
    .catch(() => {})
}

function wireToggle(input: HTMLInputElement, key: keyof Settings) {
  input.addEventListener('change', async () => {
    usage(`uiSet_${key}`)
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
async function renderUpdateBanner(): Promise<boolean> {
  const current = chrome.runtime.getManifest().version
  const lastSeen = await getLastSeenVersion()

  if (lastSeen === undefined || lastSeen === current) {
    if (lastSeen === undefined) await setLastSeenVersion(current)
    return false
  }

  const entries = changesSince(lastSeen)
  if (entries.length === 0) {
    // Updated, but nothing user-facing was logged — adopt silently.
    await setLastSeenVersion(current)
    return false
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
  return true
}

const REVIEW_NUDGE_MIN_DAYS = 14
const REVIEW_NUDGE_MIN_BLOCKED = 100

/** One-time "rate it" card. Earned, not scheduled: at least 14 days since the
 * popup first saw this feature AND a meaningful lifetime total, so it only
 * ever asks people the extension has demonstrably helped. Skipped whenever
 * the What's-new banner is up (one card at a time), and gone for good after
 * either button. */
async function renderReviewNudge() {
  const nudge = await getReviewNudge()
  if (nudge.done) return
  if (Date.now() - nudge.since < REVIEW_NUDGE_MIN_DAYS * 86_400_000) return
  const stats = await getStats()
  const total =
    stats.allTimeAdSkips +
    stats.allTimeSponsorSkips +
    stats.allTimeYtAdsHidden +
    stats.allTimeWebAdsBlocked
  if (total < REVIEW_NUDGE_MIN_BLOCKED) return

  $('review-nudge-text').textContent =
    `${total.toLocaleString()} ads skipped or blocked so far. A quick rating on the Chrome Web Store helps more people find it.`
  const banner = $('review-nudge')
  banner.hidden = false
  $('review-nudge-dismiss').addEventListener(
    'click',
    () => {
      banner.hidden = true
      void finishReviewNudge()
    },
    { once: true },
  )
  $('review-nudge-open').addEventListener(
    'click',
    () => {
      usage('uiReviews')
      void finishReviewNudge()
      void chrome.tabs.create({ url: REVIEW_URL })
      window.close()
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

// Where the ad engine last saw the content video, for the resume-after-reload
// path. 0 whenever the content script isn't there to answer.
async function tabResumeSeconds(tabId: number): Promise<number> {
  try {
    return (
      (await chrome.tabs.sendMessage(
        tabId,
        { type: 'skipSensei:getResumePosition' },
        TOP_FRAME,
      )) ?? 0
    )
  } catch {
    return 0
  }
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
    if (tab?.id !== undefined && onYouTube) {
      // Clearing cookies wipes YouTube's own resume state, so a plain reload
      // restarts the video at 0:00. Ask the content script where playback had
      // reached and navigate back to that point instead.
      const resumeUrl = withResumeTime(tab.url ?? '', await tabResumeSeconds(tab.id))
      if (resumeUrl) await chrome.tabs.update(tab.id, { url: resumeUrl })
      else await chrome.tabs.reload(tab.id)
    }
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

// Spotify web player: ads are MUTED, never blocked or skipped (in-stream
// delivery — see src/content/audio-ads.ts). Say so while the user is there,
// so "Blocking active" never reads as a promise to silence the ad slot.
// Dismissed once = stays dismissed. Shared with the in-page notice
// (src/content/spotify-notice.ts).
const SPOTIFY_NOTE_KEY = 'spotifyNoteDismissed'
async function renderSpotifyNote() {
  const el = $('spotify-note')
  const active = await activeTabHost()
  if (!active || active.host !== 'open.spotify.com') {
    el.hidden = true
    return
  }
  const stored = await chrome.storage.local.get(SPOTIFY_NOTE_KEY)
  el.hidden = stored[SPOTIFY_NOTE_KEY] === true
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

// Only ever the current tab — reloading others could lose work in progress.
async function reloadActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (tab?.id) {
    await chrome.tabs.reload(tab.id)
    window.close()
  }
}

/** Controls accordion. The section for the current site opens by default
 * (YouTube on youtube.com, Spotify on open.spotify.com, otherwise Ad
 * blocker); a manual open/close is remembered for the session's later
 * popups via localStorage — an extension-page convenience, nothing more. */
const SECTIONS = ['adblock', 'youtube', 'spotify'] as const
type Section = (typeof SECTIONS)[number]
function setSectionOpen(key: Section, open: boolean) {
  $(`sec-${key}`).hidden = !open
  document
    .querySelector<HTMLButtonElement>(`.ctl-section[data-section="${key}"] .ctl-section-head`)
    ?.setAttribute('aria-expanded', String(open))
}
function initSections(host: string | null) {
  const contextual: Section = /(^|\.)youtube\.com$/.test(host ?? '')
    ? 'youtube'
    : host === 'open.spotify.com'
      ? 'spotify'
      : 'adblock'
  // Contextual section first in the list.
  const list = $('view-controls')
  const first = list.querySelector<HTMLElement>(`.ctl-section[data-section="${contextual}"]`)
  if (first) list.prepend(first)
  let remembered: Partial<Record<Section, boolean>> = {}
  try {
    remembered = JSON.parse(localStorage.getItem('sections') ?? '{}')
  } catch {
    remembered = {}
  }
  for (const key of SECTIONS) {
    setSectionOpen(key, remembered[key] ?? key === contextual)
  }
  for (const head of document.querySelectorAll<HTMLButtonElement>('.ctl-section-head')) {
    head.addEventListener('click', () => {
      const key = head.closest<HTMLElement>('.ctl-section')!.dataset.section as Section
      const open = $(`sec-${key}`).hidden
      setSectionOpen(key, open)
      remembered[key] = open
      try {
        localStorage.setItem('sections', JSON.stringify(remembered))
      } catch {
        /* storage unavailable — fine */
      }
    })
  }
}

async function main() {
  usage('uiPopupOpens')
  $('version').textContent = chrome.runtime.getManifest().version
  // Support form prefill: the page reads ?v= into its version field.
  const reportLink = $<HTMLAnchorElement>('report-btn')
  reportLink.href = `${reportLink.href}?v=${encodeURIComponent(chrome.runtime.getManifest().version)}`

  // Bottom tab bar.
  VIEWS.forEach((view, i) => {
    const btn = $<HTMLButtonElement>(`tab-${view}`)
    btn.addEventListener('click', () => {
      if (view === 'controls') usage('uiControlsTab')
      if (view === 'stats') usage('uiStatsTab')
      selectView(view)
    })
    // Arrow keys move between tabs, the way a tablist is expected to behave.
    btn.addEventListener('keydown', (e) => {
      const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
      if (!step) return
      e.preventDefault()
      const next = VIEWS[(i + step + VIEWS.length) % VIEWS.length]
      selectView(next)
      $<HTMLButtonElement>(`tab-${next}`).focus()
    })
  })
  $('home-stats').addEventListener('click', () => selectView('stats'))

  void renderUpdateBanner().then((shown) => {
    if (!shown) void renderReviewNudge()
  })
  void renderKeyReminder()
  void renderSpotifyNote()
  $('spotify-note-dismiss').addEventListener('click', () => {
    $('spotify-note').hidden = true
    void chrome.storage.local.set({ [SPOTIFY_NOTE_KEY]: true })
  })

  // Always-available "reset this site": clear cookies + reload. Only meaningful
  // on a real web page, so reveal it only when the active tab has an http(s) host.
  const resetSiteBtn = $<HTMLButtonElement>('reset-site-btn')
  const active = await activeTabHost()
  resetSiteBtn.hidden = !active
  resetSiteBtn.addEventListener('click', (e) => {
    void clearSiteCookiesAndReload(
      e.currentTarget as HTMLButtonElement,
      $('reset-site-label'),
    )
  })
  initSections(active?.host ?? null)

  renderSettings(await getSettings())
  renderStats(await getStats())
  onStatsChanged(renderStats)
  for (const btn of document.querySelectorAll<HTMLButtonElement>('.seg-btn[data-range]')) {
    btn.addEventListener('click', () => selectRange(btn.dataset.range as Range))
  }
  $('reset-stats-btn').addEventListener('click', async () => {
    const btn = $<HTMLButtonElement>('reset-stats-btn')
    if (btn.dataset.armed !== '1') {
      // Two-tap confirm instead of a modal: first tap arms, second clears.
      btn.dataset.armed = '1'
      btn.querySelector('.ctl-sub')!.textContent = 'Tap again to confirm'
      setTimeout(() => {
        btn.dataset.armed = ''
        btn.querySelector('.ctl-sub')!.textContent = 'Reset every counter to zero'
      }, 4000)
      return
    }
    btn.dataset.armed = ''
    await resetStats()
    renderStats(await getStats())
    btn.querySelector('.ctl-sub')!.textContent = 'Cleared'
  })

  // The ⓘ tips render via CSS from data-tip, which screen readers never see —
  // mirror each tip into aria-label so focusing the icon announces it.
  document.querySelectorAll<HTMLElement>('.info[data-tip]').forEach((el) => {
    if (el.dataset.tip) el.setAttribute('aria-label', el.dataset.tip)
  })

  wireToggle(masterToggle, 'masterEnabled')
  wireToggle(adToggle, 'adEngineEnabled')
  wireToggle(sponsorToggle, 'sponsorEngineEnabled')
  wireToggle(aggressiveToggle, 'aggressivePruning')
  wireToggle(aiEnhancementsToggle, 'aiEnhancements')
  const afterRulesetChange = () =>
    setTimeout(() => {
      void renderStatus()
      void renderSiteSection()
    }, 300)
  blockAdsToggle.addEventListener('change', async () => {
    usage('uiSet_blockAllAds')
    renderSettings(await updateSettings({ blockAllAds: blockAdsToggle.checked }))
    afterRulesetChange() // give the SW a moment to flip the rulesets
  })
  for (const key of OPT_KEYS) {
    const el = document.getElementById(`opt-${key}`) as HTMLInputElement | null
    if (!el) continue
    el.addEventListener('change', async () => {
      usage(`uiSet_${key}`)
      renderSettings(await updateSettings({ [key]: el.checked } as Pick<Settings, OptKey>))
      if (RULESET_KEYS.has(key)) afterRulesetChange()
    })
  }
  masterToggle.addEventListener('change', () => void renderStatus())

  pauseSiteToggle.addEventListener('change', async () => {
    if (!currentHost) return
    usage('uiSitePauses')
    await setSiteAllowlisted(currentHost, pauseSiteToggle.checked)
    void renderSiteSection()
  })

  $('reload-page').addEventListener('click', () => void reloadActiveTab())
  reloadTabEl.addEventListener('click', () => void reloadActiveTab())

  // Deep links into the options page — its hash router (options.ts
  // showPanel) opens the matching sidebar panel directly.
  const openOptionsPanel = (panel: string) => {
    void chrome.tabs.create({
      url: chrome.runtime.getURL('options.html') + '#' + panel,
    })
    window.close()
  }
  $('open-options').addEventListener('click', () => openOptionsPanel('ai'))
  $('open-filters').addEventListener('click', () => openOptionsPanel('adblock'))
  // SponsorBlock categories, confidence, debug logging stay on the options
  // page on purpose — config, not mid-browse switches.
  $('open-yt-options').addEventListener('click', () => openOptionsPanel('youtube'))
  $('whatsnew-btn').addEventListener('click', () => {
    void chrome.tabs.create({
      url: 'https://www.singlefinmedia.com/ad-sensei/release-notes',
    })
    window.close()
  })
  $('rate-btn').addEventListener('click', () => {
    usage('uiReviews')
    void finishReviewNudge()
    void chrome.tabs.create({ url: REVIEW_URL })
    window.close()
  })

  // Clicking an ⓘ shouldn't toggle the switch it sits inside — hover only.
  document.querySelectorAll('.info').forEach((el) =>
    el.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
    }),
  )

  const shareBtn = $<HTMLButtonElement>('share-btn')
  const shareSub = shareBtn.querySelector<HTMLElement>('.ctl-sub')!
  shareBtn.addEventListener('click', async () => {
    usage('uiShares')
    const shareUrl = SHARE_URL
    const shareText =
      'Skip YouTube ads & creator sponsor segments, and block ads across the web with Ad Sensei.'
    const nav = navigator as Navigator & {
      share?: (data: ShareData) => Promise<void>
    }
    // Only ever hand navigator.share() an absolute http(s) URL. A relative or
    // empty `url` resolves against the popup's own chrome-extension:// origin,
    // and the browser treats a non-http(s) Web Share URL as a bad IPC message
    // and KILLS the renderer — i.e. "Ad Sensei has crashed" on every click
    // (that was the '' placeholder before the store listing existed).
    if (nav.share && /^https?:\/\//.test(shareUrl)) {
      try {
        await nav.share({ title: 'Ad Sensei', text: shareText, url: shareUrl })
        return
      } catch {
        // user cancelled or share unavailable — fall through to copy
      }
    }
    try {
      await navigator.clipboard.writeText(`${shareText} ${shareUrl}`)
      const original = shareSub.textContent
      shareSub.textContent = '✓ Link copied'
      setTimeout(() => (shareSub.textContent = original), 1500)
    } catch {
      // clipboard blocked — nothing more to do
    }
  })

  void renderStatus()
  void renderVideoStatus()
  void renderSiteSection()
  void renderHiddenReview()

  setHiddenCollapsed(true) // always start collapsed on open
  $('sponsor-toggle').addEventListener('click', () => {
    sponsorSegmentsExpanded = !sponsorSegmentsExpanded
    void renderVideoStatus()
  })
  const reanalyzeBtn = $<HTMLButtonElement>('sponsor-reanalyze')
  reanalyzeBtn.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tab?.id) return
    reanalyzeBtn.disabled = true
    reanalyzeBtn.classList.add('spinning') // immediate feedback; poll takes over
    try {
      await chrome.tabs.sendMessage(
        tab.id,
        { type: 'skipSensei:reanalyzeSponsors' },
        TOP_FRAME,
      )
    } catch {
      /* content script not ready — the 1s poll will restore the real state */
    }
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
  // timer ticking smoothly. The blocked-count refresh is DELIBERATELY slower:
  // each one triggers a live getMatchedRules recount in the SW, and that API
  // is quota-limited to 20 calls per 10 minutes — a 1s cadence exhausted the
  // quota in ~20s of the popup being open and then starved the badge counts
  // for everyone. 10s keeps a lingering popup well inside the budget.
  let tick = 0
  setInterval(() => {
    void renderVideoStatus()
    if (++tick % 10 === 0) void renderSiteSection()
  }, 1000)
}

void main()
