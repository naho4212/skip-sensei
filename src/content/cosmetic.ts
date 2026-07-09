import { log } from '../log'
import {
  addRejectedGapfill,
  getGapfillSelectors,
  getRejectedGapfill,
  getSettings,
  onSettingsChanged,
  setGapfillSelectors,
} from '../storage'
import { initConsent } from './consent'
import { initPopupReviewer } from './popup-reviewer'

/**
 * Cosmetic filtering (Phase 6): hides ad *containers* by CSS selector, which
 * network blocking can't do — leftover empty ad boxes and first-party promo
 * banners served from the site's own server.
 *
 * Runs on all sites at document_start (only when "Block all ads" is on and the
 * site isn't allowlisted). Conservative, high-signal selectors: broad enough
 * to catch common ad wrappers (verified against real sites), specific enough to
 * avoid hiding real content. The per-site allowlist is the escape hatch if a
 * page over-hides.
 */

const STYLE_ID = 'skip-sensei-cosmetic'

const SELECTORS = [
  // Google / programmatic ad slots
  'ins.adsbygoogle',
  '.adsbygoogle',
  '[id^="div-gpt-ad"]',
  '[id*="div-gpt-ad"]',
  '[id^="google_ads_"]',
  '[id*="google_ads_iframe"]',
  'iframe[src*="doubleclick.net"]',
  'iframe[src*="googlesyndication"]',
  'iframe[src*="adnxs.com"]',
  'iframe[src*="amazon-adsystem"]',
  'iframe[id*="google_ads"]',
  'iframe[title="Advertisement" i]',
  // Common ad-wrapper class/id conventions (verified on real sites)
  '.advertisement',
  '[class*="ad-container"]',
  '[class*="AdContainer"]',
  '[class*="ad-wrapper"]',
  '[class*="AdWrapper"]',
  '[class*="ad-slot"]',
  '[class*="AdSlot"]',
  '[class*="ad-unit"]',
  '[class*="ad-banner"]',
  '[class*="AdBanner"]',
  '[class*="ad-placeholder"]',
  '[class*="ad-leaderboard"]',
  '[class*="StickyHeroAd"]',
  '[class*="ad-stickyhero"]',
  '[class*="ad--"]',
  '[class*="-advertisement"]',
  '[class*="advertisement-"]',
  '[id*="banner-ad"]',
  '[class*="banner-ad"]',
  // Data-attribute and ARIA ad markers
  '[data-ad-slot]',
  '[data-adunit]',
  '[data-ad-unit]',
  '[data-ad-region]',
  '[aria-label="Advertisement" i]',
]

/**
 * YouTube's own promoted/sponsored items: first-party custom elements served
 * from youtube.com, so there's no ad-network request the DNR filter lists can
 * block — they only disappear via cosmetic hiding. Every tag here is
 * ad-specific (none match real videos). Hiding the wrapping rich-item removes
 * the whole feed card so no empty gap is left. Applied only on youtube.com.
 *
 * Deliberately NOT keyed off the "Sponsored" badge class (.ytBadgeShapeText),
 * which also labels real videos ("4K", "New", "Live") and would over-hide.
 * Never touch ytd-masthead — that's the header/search bar, not an ad.
 */
const YOUTUBE_SELECTORS = [
  'ytd-ad-slot-renderer',
  'ytd-rich-item-renderer:has(ytd-ad-slot-renderer)', // home-feed ad card
  'ytd-in-feed-ad-layout-renderer',
  'ytd-rich-section-renderer:has(ytd-statement-banner-renderer)',
  'ytd-statement-banner-renderer',
  'ytd-brand-video-shelf-renderer',
  'ytd-brand-video-singleton-renderer',
  'ytd-promoted-sparkles-web-renderer',
  'ytd-promoted-sparkles-text-search-renderer',
  'ytd-promoted-video-renderer',
  'ytd-search-pyv-renderer', // promoted result in search
  'ytd-display-ad-renderer',
  'ytd-carousel-ad-renderer',
  'ytd-companion-slot-renderer',
  'ytd-action-companion-ad-renderer',
  'ytd-player-legacy-desktop-watch-ads-renderer',
  '#masthead-ad', // homepage top banner
  // Watch-page sidebar "ads engagement panel" (a newer display-ad format).
  // Hide only the panel that actually contains the ad content — the generic
  // ytd-engagement-panel-section-list-renderer also holds chapters/transcript.
  'ytd-ads-engagement-panel-content-renderer',
  'ytd-engagement-panel-section-list-renderer:has(ytd-ads-engagement-panel-content-renderer)',
  // Cards the heuristic badge-scanner tags (see scanForAdBadges): a new ad
  // format with no known renderer tag but a "Sponsored" badge in an ad slot.
  '.skip-sensei-adcard',
]

function isYouTube(): boolean {
  return /(^|\.)youtube\.com$/.test(location.hostname)
}

const GAPFILL_STYLE_ID = 'skip-sensei-gapfill'

function isValidSelectorList(list: string[]): string[] {
  return list.filter((s) => {
    try {
      document.querySelector(s)
      return true
    } catch {
      return false
    }
  })
}

function buildCss(selectors: string[]): string {
  return `${selectors.join(',')}{display:none!important}`
}

function isAllowlisted(allowlist: string[]): boolean {
  const host = location.hostname
  const bare = host.replace(/^www\./, '')
  return allowlist.includes(host) || allowlist.includes(bare)
}

function bareDomain(): string {
  return location.hostname.replace(/^www\./, '')
}

async function blockingActive(): Promise<boolean> {
  const settings = await getSettings()
  return (
    settings.masterEnabled &&
    settings.blockAllAds &&
    !isAllowlisted(settings.allowlist)
  )
}

/** Generic + YouTube selectors currently injected (for the popup review). */
let activeSelectors: string[] = []

async function apply() {
  const settings = await getSettings()
  const allowed = settings.masterEnabled && !isAllowlisted(settings.allowlist)
  // Generic web ad hiding is the "Block all ads" feature. YouTube's own
  // display ads (feed/sidebar/masthead) are also hidden when "Skip YouTube
  // ads" is on — a YouTube display ad slipping through is surprising when
  // ad-skipping is enabled.
  const genericOn = allowed && settings.blockAllAds
  const ytOn =
    allowed &&
    isYouTube() &&
    (settings.blockAllAds || settings.adEngineEnabled)

  // Per-site "not an ad" selectors the user un-hid stay un-hidden.
  const rejected = new Set(await getRejectedGapfill(bareDomain()))
  const selectors = [
    ...(genericOn ? SELECTORS : []),
    ...(ytOn ? YOUTUBE_SELECTORS : []),
  ].filter((s) => !rejected.has(s))
  activeSelectors = selectors

  const existing = document.getElementById(STYLE_ID) as HTMLStyleElement | null
  if (selectors.length === 0) {
    existing?.remove()
    document.getElementById(GAPFILL_STYLE_ID)?.remove()
  } else {
    const style = existing ?? document.createElement('style')
    style.id = STYLE_ID
    style.textContent = buildCss(selectors)
    if (!existing) (document.head ?? document.documentElement).appendChild(style)
  }
  if (genericOn) void applyGapfill() // hide anything the AI found on prior visits

  if (ytOn) startAdBadgeScanner()
  else stopAdBadgeScanner()
}

// ---------------------------------------------------------------------------
// Heuristic ad-badge scanner (YouTube). YouTube rotates ad renderers, so a
// new format can slip past the structural selectors above. As a fallback,
// find an ad-disclosure badge — YouTube's ad-specific <ad-badge-view-model>,
// or a badge whose EXACT text is "Sponsored" — and tag the card that contains
// it so the stylesheet's `.skip-sensei-adcard` rule hides it.
//
// The exact-text match is deliberate: real videos carry badges like "4K" /
// "New" / "Live", never a standalone "Sponsored". And we never look inside the
// player, comments, description, watch metadata, or live chat, where
// "Sponsored" / "paid promotion" text is legitimate content.
// ---------------------------------------------------------------------------

const AD_CARD_CLASS = 'skip-sensei-adcard'
/** Badge text that unambiguously marks an ad (exact match only). */
const AD_BADGE_TEXT = /^sponsored$/i
/** Containers we're willing to hide when they hold an ad badge. */
const AD_CARD_ANCESTORS = [
  'ytd-rich-item-renderer',
  'ytd-ad-slot-renderer',
  'ytd-companion-slot-renderer',
  'ytd-engagement-panel-section-list-renderer',
  'ytd-compact-video-renderer',
  'ytd-video-renderer',
  'yt-lockup-view-model',
  'ytd-rich-section-renderer',
]
/** Legit "Sponsored"/"paid promotion" text lives here — never touch it. */
const PROTECTED_ANCESTORS =
  '#movie_player, ytd-comments, #comments, ytd-comment-thread-renderer, ' +
  'ytd-watch-metadata, #description, #description-inner, ' +
  'ytd-live-chat-frame, #chat, ytd-video-description-header-renderer'

function isAdBadge(el: Element): boolean {
  if (el.tagName.toLowerCase() === 'ad-badge-view-model') return true
  if (/ad-badge/i.test(String(el.className))) return true
  return AD_BADGE_TEXT.test((el.textContent ?? '').trim())
}

function scanForAdBadges() {
  const badges = document.querySelectorAll(
    '.ytBadgeShapeText, ad-badge-view-model, [class*="ad-badge" i]',
  )
  for (const badge of badges) {
    if (!isAdBadge(badge)) continue
    if (badge.closest(PROTECTED_ANCESTORS)) continue
    let card: Element | null = null
    for (const sel of AD_CARD_ANCESTORS) {
      card = badge.closest(sel)
      if (card) break
    }
    if (card && !card.classList.contains(AD_CARD_CLASS)) {
      card.classList.add(AD_CARD_CLASS)
      log('heuristic: tagged ad card via "Sponsored" badge —', card.tagName.toLowerCase())
    }
  }
}

let badgeObserver: MutationObserver | null = null
let scanScheduled = false

function scheduleScan() {
  if (scanScheduled) return
  scanScheduled = true
  setTimeout(() => {
    scanScheduled = false
    scanForAdBadges()
  }, 500)
}

function startAdBadgeScanner() {
  if (badgeObserver) return
  scanForAdBadges()
  badgeObserver = new MutationObserver(() => scheduleScan())
  badgeObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
  })
}

function stopAdBadgeScanner() {
  badgeObserver?.disconnect()
  badgeObserver = null
  document
    .querySelectorAll(`.${AD_CARD_CLASS}`)
    .forEach((el) => el.classList.remove(AD_CARD_CLASS))
}

/**
 * A gap-fill selector is only safe to APPLY if it plausibly targets ads and
 * not the site's own UI. The AI occasionally mislabels app chrome as ads
 * (e.g. it flagged Claude's sidebar nav), so refuse any selector that:
 *  - matches many elements (ads are few), or
 *  - matches a link/button or the primary nav/header, or
 *  - matches a container that holds several links (a menu/nav, not an ad).
 * Cheap and DOM-specific, so it also self-heals a bad cached selector.
 */
function isSafeGapfillSelector(sel: string): boolean {
  let els: Element[]
  try {
    els = Array.from(document.querySelectorAll(sel))
  } catch {
    return false
  }
  if (els.length === 0) return true // nothing here now — harmless
  if (els.length > 6) return false // too broad to be "a few ads"
  return els.every((el) => {
    const tag = el.tagName.toLowerCase()
    if (tag === 'a' || tag === 'button' || tag === 'nav' || tag === 'header')
      return false
    if (
      el.closest(
        'nav, header, [role="navigation"], [role="banner"], [role="menu"], [role="menubar"]',
      )
    )
      return false
    // A container holding several links is navigation, not an ad unit.
    if (el.querySelectorAll('a[href], button').length >= 3) return false
    return true
  })
}

/** Currently-applied gap-fill selectors on this page (for the popup review). */
let activeGapfill: string[] = []

/** Apply this domain's AI-discovered ad selectors (from prior visits). */
async function applyGapfill() {
  const rejected = new Set(await getRejectedGapfill(bareDomain()))
  const raw = isValidSelectorList(await getGapfillSelectors(bareDomain())).filter(
    (s) => !rejected.has(s),
  )
  const safe = raw.filter(isSafeGapfillSelector)
  // Purge selectors that turned out to hit real UI so they never apply again.
  if (safe.length !== raw.length) {
    log('purged unsafe gap-fill selectors:', raw.filter((s) => !safe.includes(s)))
    void setGapfillSelectors(bareDomain(), safe)
  }
  activeGapfill = safe
  const existing = document.getElementById(GAPFILL_STYLE_ID)
  if (safe.length === 0) {
    existing?.remove()
    return
  }
  const style =
    (existing as HTMLStyleElement | null) ?? document.createElement('style')
  style.id = GAPFILL_STYLE_ID
  style.textContent = buildCss(safe)
  if (!existing) (document.head ?? document.documentElement).appendChild(style)
}

void apply()
onSettingsChanged(() => void apply())

/**
 * Whether this page currently has ad content that loaded from the network —
 * ad-network iframes or filled AdSense slots. Their presence means the page
 * loaded before blocking took effect, so a reload would clear them. (Network
 * blocking only affects new requests; it can't un-load already-fetched ads.)
 */
const AD_IFRAME_HINTS = [
  'doubleclick',
  'googlesyndication',
  'adnxs',
  'amazon-adsystem',
  'adservice',
  'adsystem',
  '/ads/',
  '/adserver',
]

function pageHasLoadedAds(): boolean {
  for (const frame of document.querySelectorAll<HTMLIFrameElement>('iframe[src]')) {
    const src = frame.src.toLowerCase()
    if (AD_IFRAME_HINTS.some((h) => src.includes(h))) return true
  }
  return !!document.querySelector('ins.adsbygoogle[data-ad-status="filled"]')
}

/** Human-readable summary of everything the extension is hiding on this page
 * (filter-list + YouTube + AI gap-fill), for the popup review. Capped so a
 * heavy ad page doesn't flood the popup. */
function describeHiddenElements() {
  const isYt = isYouTube()
  const sources: Array<{ selector: string; source: 'list' | 'ai' | 'youtube' }> =
    [
      ...activeSelectors.map((selector) => ({
        selector,
        source: (isYt && /^ytd-|^#masthead|skip-sensei-adcard/.test(selector)
          ? 'youtube'
          : 'list') as 'list' | 'youtube',
      })),
      ...activeGapfill.map((selector) => ({
        selector,
        source: 'ai' as const,
      })),
    ]
  const out = []
  for (const { selector, source } of sources) {
    let els: Element[] = []
    try {
      els = Array.from(document.querySelectorAll(selector))
    } catch {
      continue
    }
    if (els.length === 0) continue
    const first = els[0]
    out.push({
      selector,
      source,
      count: els.length,
      tag: first.tagName.toLowerCase(),
      text: (first.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 70),
    })
    if (out.length >= 25) break
  }
  return out
}

/** User marked a hidden selector "not an ad": un-hide it, block it here for
 * good, and report the correction. */
async function rejectHiddenSelector(selector: string) {
  const domain = bareDomain()
  await addRejectedGapfill(domain, selector)
  const current = await getGapfillSelectors(domain)
  await setGapfillSelectors(
    domain,
    current.filter((s) => s !== selector),
  )
  await apply() // re-inject filter-list/YouTube style without it
  await applyGapfill() // and the gap-fill style → un-hides immediately
  reportGapfillFeedback(selector, 'not-ad')
}

function reportGapfillFeedback(selector: string, verdict: 'ad' | 'not-ad') {
  try {
    void chrome.runtime.sendMessage({
      type: 'skipSensei:event',
      kind: 'gapfill_feedback',
      fields: { domain: bareDomain(), selector, verdict },
    })
  } catch {
    /* orphaned — nothing to report to */
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'skipSensei:pageHasAds') {
    sendResponse(pageHasLoadedAds())
  } else if (message?.type === 'skipSensei:getHiddenElements') {
    sendResponse(describeHiddenElements())
  } else if (message?.type === 'skipSensei:rejectHiddenSelector') {
    void rejectHiddenSelector(message.selector).then(() =>
      sendResponse({ ok: true }),
    )
    return true // async response
  } else if (message?.type === 'skipSensei:confirmHiddenSelector') {
    reportGapfillFeedback(message.selector, 'ad')
    sendResponse({ ok: true })
  } else if (message?.type === 'skipSensei:scanForAds') {
    void scanForAds().then(sendResponse)
    return true // async response
  }
})

/**
 * Tell the service worker whether this tab has leftover ads (so it can badge
 * the icon). Runs after the page settles and on settings changes; ads load
 * asynchronously, so we sample a couple of times.
 */
async function reportReloadState() {
  const settings = await getSettings()
  const blocking =
    settings.masterEnabled &&
    settings.blockAllAds &&
    !isAllowlisted(settings.allowlist)
  const needsReload = blocking && pageHasLoadedAds()
  chrome.runtime
    .sendMessage({ type: 'skipSensei:tabNeedsReload', needsReload })
    .catch(() => {})
}

function scheduleReloadChecks() {
  setTimeout(() => void reportReloadState(), 1500)
  setTimeout(() => void reportReloadState(), 4000)
}

/**
 * AI gap-filler: after the page settles, look for ad content the filter lists
 * missed (ad-network iframes, "advertisement"/"sponsored"-labelled blocks) and
 * ask the AI which elements to hide. Cached per domain so it's a one-time cost
 * per site, and only runs when aiEnhancements is on. Conservative: only sends
 * a compact fragment of ad-suspect regions, never the whole page.
 */
const AD_SUSPECT_HINTS = [
  'doubleclick',
  'googlesyndication',
  'adnxs',
  'amazon-adsystem',
  'adservice',
  '/ads/',
  '/adserver',
]

function collectAdSuspects(): string {
  const parts: string[] = []
  const seen = new Set<Element>()
  const add = (el: Element | null) => {
    if (!el || seen.has(el)) return
    seen.add(el)
    // Send a shallow outline (tag + attributes + a little context), not deep subtrees.
    parts.push(el.outerHTML.slice(0, 600))
  }
  // Ad-network iframes and their containers.
  for (const frame of document.querySelectorAll<HTMLIFrameElement>('iframe[src]')) {
    const src = frame.src.toLowerCase()
    if (AD_SUSPECT_HINTS.some((h) => src.includes(h))) add(frame.parentElement ?? frame)
  }
  // Elements self-labelled as ads/sponsored that our static selectors missed.
  for (const el of document.querySelectorAll(
    '[class*="sponsor" i],[class*="promo" i],[aria-label*="advert" i],[data-testid*="ad" i]',
  )) {
    if (parts.length > 20) break
    if (el instanceof HTMLElement && el.offsetHeight > 30) add(el)
  }
  return parts.join('\n')
}

async function runGapfill() {
  if (!(await blockingActive())) return
  const settings = await getSettings()
  if (!settings.aiEnhancements) return
  // Already learned this domain — the cached selectors were applied on load;
  // don't spend another LLM call.
  if ((await getGapfillSelectors(bareDomain())).length > 0) return
  const html = collectAdSuspects()
  if (!html.trim()) return
  const selectors: string[] | null = await chrome.runtime
    .sendMessage({
      type: 'skipSensei:findAdSelectors',
      html,
      domain: bareDomain(),
    })
    .catch(() => null)
  if (selectors && selectors.length > 0) {
    log('gap-filler hid', selectors.length, 'ad element(s):', selectors)
    void applyGapfill()
  }
}

/**
 * On-demand gap-filler for the popup "Scan for ads" button — ignores the
 * once-per-domain guard so the user can test the AI on any page and review
 * what it proposes. Returns the current hidden-element summary.
 */
async function scanForAds() {
  const settings = await getSettings()
  if (settings.aiEnhancements && !settings.localOnlyMode) {
    const html = collectAdSuspects()
    if (html.trim()) {
      const selectors: string[] | null = await chrome.runtime
        .sendMessage({
          type: 'skipSensei:findAdSelectors',
          html,
          domain: bareDomain(),
        })
        .catch(() => null)
      if (selectors?.length) log('manual scan proposed:', selectors)
    }
  }
  await applyGapfill()
  return describeHiddenElements()
}

function onPageReady() {
  scheduleReloadChecks()
  // Re-apply now the DOM exists: the gap-fill safety check needs real elements
  // to see whether a cached selector is hitting the site's own UI (it can't at
  // document_start), and purge it if so. A short follow-up catches late nav.
  void apply()
  setTimeout(() => void apply(), 2000)
  // Give ads time to load, then scan once for anything the lists missed.
  setTimeout(() => void runGapfill(), 3500)
  initConsent() // AI cookie-consent auto-reject
}

if (document.readyState === 'complete') onPageReady()
else window.addEventListener('load', onPageReady)
onSettingsChanged(() => {
  void reportReloadState()
  initPopupReviewer()
  initConsent()
})

// AI-reviewed popup/overlay blocking (gates itself on settings internally).
initPopupReviewer()
