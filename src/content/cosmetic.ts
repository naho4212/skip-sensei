import { log } from '../log'
import {
  addConfirmedGapfill,
  addGapfillSelectors,
  addRejectedGapfill,
  getConfirmedGapfill,
  getGapfillSelectors,
  getRejectedGapfill,
  getSettings,
  getVetoedGapfill,
  onSettingsChanged,
  recordActivity,
  removeVetoedGapfill,
  setGapfillSelectors,
  setVetoedGapfill,
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
  // Husks the empty-ad-slot collapser tags (see collapseEmptyAdSlots): space
  // a site reserved for an ad that network blocking stopped from loading.
  '.skip-sensei-empty-slot',
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

/**
 * Google search "Sponsored" results: like YouTube's promoted items, they're
 * first-party HTML served inline from google.com itself — there's no
 * ad-network request for the DNR lists to block (and blocking google.com
 * would break search). Only cosmetic hiding works. These ids/classes are
 * Google's own ad-container markers, stable for years and used ONLY for paid
 * units — organic results never carry them. Applied on Google search domains
 * only.
 */
const GOOGLE_SEARCH_SELECTORS = [
  '#tads', // top "Sponsored" text-ad block
  '#tadsb', // bottom "Sponsored" block (newer id)
  '#bottomads', // bottom "Sponsored" block (classic id)
  '[data-text-ad]', // individual text ad
  '.commercial-unit-desktop-top', // shopping/product-listing ads, top
  '.commercial-unit-desktop-rhs', // shopping ads, right-hand side
  '.cu-container', // shopping ad unit container
]

/**
 * Pinterest sponsored pins: first-party ads again — cosmetic-only. Pinterest's
 * class names are hashed and rotate every build, so key off the stable bits:
 * the pin wrapper ([data-grid-item]) and the ad label's title attribute
 * ("Sponsored" / "Promoted by …"), which organic pins never carry. Verified
 * live: matches exactly the sponsored pins, zero organic. Note: hiding leaves
 * a blank slot until Pinterest's masonry relayouts on scroll — the grid
 * positions are precomputed, and only Pinterest's own code can re-flow them.
 * English-locale labels only for now.
 */
const PINTEREST_SELECTORS = [
  '[data-grid-item]:has([title="Sponsored" i])',
  '[data-grid-item]:has([title^="Promoted by" i])',
]

/**
 * Amazon sponsored results & brand/video ad units. .AdHolder is Amazon's own
 * marker on every advertising widget (also what EasyList keys on); verified
 * live: 17 units on a search page, every one ad content, zero organic.
 * sp-sponsored-result is an older per-result marker kept as belt-and-braces.
 */
const AMAZON_SELECTORS = [
  '.AdHolder',
  '[data-component-type="sp-sponsored-result"]',
]

/**
 * Reddit promoted posts: ad-only custom elements (same pattern as YouTube's
 * ad renderers — the tag name itself is the ad marker), plus old.reddit's
 * .promotedlink. Verified live: 5 shreddit-ad-post in the r/all feed.
 */
const REDDIT_SELECTORS = [
  'shreddit-ad-post',
  'shreddit-comments-page-ad',
  'shreddit-sidebar-ad',
  'shreddit-dynamic-ad-link',
  '.promotedlink',
]

/**
 * Bing search ads: .b_ad has been Bing's ad-block container for a decade
 * (EasyList's marker too). Verified live: 3 ad blocks hidden, organic
 * .b_algo results untouched.
 */
const BING_SELECTORS = ['.b_ad']

/**
 * First-party ad platforms: the site sells its own ads and serves them
 * inline from its own domain as regular content — there is no ad-network
 * request for the DNR lists to block, so cosmetic hiding is the only tool.
 * Each entry uses the site's own stable ad-only markers, live-verified.
 * (YouTube is handled separately above with its own toggle semantics.)
 *
 * mode 'placeholder': for layouts that can't reflow (Pinterest's masonry
 * precomputes absolute pin positions — display:none leaves a bare hole only
 * Pinterest's own code could close). Instead of hiding, the slot keeps its
 * size and shows a subtle "Ad hidden" marker. Everywhere else, flow layout
 * reflows on display:none and content moves up on its own — same as YouTube.
 */
const FIRST_PARTY_AD_SITES: Array<{
  hosts: RegExp
  selectors: string[]
  mode?: 'placeholder'
}> = [
  // google.com, google.de, google.co.uk, … (any national TLD)
  { hosts: /(^|\.)google\.[a-z]{2,3}(\.[a-z]{2})?$/, selectors: GOOGLE_SEARCH_SELECTORS },
  {
    hosts: /(^|\.)pinterest\.[a-z]{2,3}(\.[a-z]{2})?$/,
    selectors: PINTEREST_SELECTORS,
    mode: 'placeholder',
  },
  { hosts: /(^|\.)amazon\.[a-z]{2,3}(\.[a-z]{2})?$/, selectors: AMAZON_SELECTORS },
  { hosts: /(^|\.)reddit\.com$/, selectors: REDDIT_SELECTORS },
  { hosts: /(^|\.)bing\.com$/, selectors: BING_SELECTORS },
]

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
  if (selectors.length === 0) return ''
  return `${selectors.join(',')}{display:none!important}`
}

/** Placeholder mode: keep the slot's size, blank its content, and label it —
 * for masonry layouts where collapsing would leave a bare hole anyway. */
function buildPlaceholderCss(selectors: string[]): string {
  if (selectors.length === 0) return ''
  const slots = selectors.join(',')
  const children = selectors.map((s) => `${s} > *`).join(',')
  const labels = selectors.map((s) => `${s}::after`).join(',')
  return (
    `${slots}{position:relative!important}` +
    `${children}{visibility:hidden!important}` +
    `${labels}{content:"Ad hidden";position:absolute;inset:0;display:flex;` +
    `align-items:center;justify-content:center;` +
    `font:500 11px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;` +
    `letter-spacing:0.04em;text-transform:uppercase;` +
    `color:rgba(128,128,136,0.55);border:1.5px dashed rgba(128,128,136,0.3);` +
    `border-radius:16px;pointer-events:none}`
  )
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
  const siteHits = genericOn
    ? FIRST_PARTY_AD_SITES.filter((site) => site.hosts.test(location.hostname))
    : []
  const hideSelectors = [
    ...(genericOn ? SELECTORS : []),
    ...siteHits
      .filter((site) => site.mode !== 'placeholder')
      .flatMap((site) => site.selectors),
    ...(ytOn ? YOUTUBE_SELECTORS : []),
  ].filter((s) => !rejected.has(s))
  const placeholderSelectors = siteHits
    .filter((site) => site.mode === 'placeholder')
    .flatMap((site) => site.selectors)
    .filter((s) => !rejected.has(s))
  activeSelectors = [...hideSelectors, ...placeholderSelectors]

  const existing = document.getElementById(STYLE_ID) as HTMLStyleElement | null
  if (activeSelectors.length === 0) {
    existing?.remove()
    document.getElementById(GAPFILL_STYLE_ID)?.remove()
  } else {
    const style = existing ?? document.createElement('style')
    style.id = STYLE_ID
    style.textContent =
      buildCss(hideSelectors) + buildPlaceholderCss(placeholderSelectors)
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
    // Interactive/form elements are never the right thing to hide as "an ad"
    // (telemetry caught the AI proposing a job-application address input).
    if (
      el.matches(
        'a, button, nav, header, input, select, textarea, form, label, fieldset',
      )
    )
      return false
    if (
      el.closest(
        'form, nav, header, [role="navigation"], [role="banner"], [role="menu"], [role="menubar"]',
      )
    )
      return false
    // A container holding form fields is functional UI, not an ad unit.
    if (el.querySelector('input, select, textarea')) return false
    // A container holding several links is navigation, not an ad unit.
    if (el.querySelectorAll('a[href], button').length >= 3) return false
    return true
  })
}

/** Currently-applied gap-fill selectors on this page (for the popup review). */
let activeGapfill: string[] = []
/** AI proposals the safety guard refused to apply (for the popup review). */
let activeVetoed: string[] = []

/** Apply this domain's AI-discovered ad selectors (from prior visits). */
async function applyGapfill() {
  const domain = bareDomain()
  const rejected = new Set(await getRejectedGapfill(domain))
  // User pressed "it IS an ad" on a guard-vetoed selector — trust them.
  const confirmed = new Set(await getConfirmedGapfill(domain))
  const raw = isValidSelectorList(await getGapfillSelectors(domain)).filter(
    (s) => !rejected.has(s),
  )
  const safe = raw.filter((s) => confirmed.has(s) || isSafeGapfillSelector(s))
  // Move selectors that turned out to hit real UI to the vetoed list so they
  // never apply, but stay reviewable in the popup.
  if (safe.length !== raw.length) {
    const unsafe = raw.filter((s) => !safe.includes(s))
    log('safety guard vetoed cached gap-fill selectors:', unsafe)
    await setGapfillSelectors(domain, safe)
    await setVetoedGapfill(domain, unsafe)
  }
  activeGapfill = safe
  activeVetoed = ((await getVetoedGapfill(domain)) ?? []).filter(
    (s) => !rejected.has(s),
  )
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

// ---------------------------------------------------------------------------
// Empty ad-slot collapser. Network blocking stops the ad request, but many
// sites pre-reserve the slot (min-height + a bare "AD" label) to avoid layout
// shift — leaving a big blank box where the ad would have been. Find those
// husks and tag them so the stylesheet collapses them; the surrounding flow
// layout reflows and content moves up, same as YouTube. Conservative: only
// elements that look like ad slots by name or label, hold no real content,
// and contain nothing interactive.
// ---------------------------------------------------------------------------

const EMPTY_SLOT_CLASS = 'skip-sensei-empty-slot'
const SLOT_NAME_RE =
  /(^|[-_ ])ads?([-_ ]|$)|advert|sponsor|adsense|doubleclick|(^|[-_ ])gpt([-_ ]|$)|dfp/i
const SLOT_LABEL_RE = /^(ad|ads|advertisement|sponsored)$/i

function isEmptyAdSlot(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect()
  if (rect.height < 60 || rect.height > 1000 || rect.width < 100) return false
  // Anything interactive or media-bearing is not an empty husk.
  if (
    el.querySelector('a[href], button, input, select, textarea, video, canvas')
  )
    return false
  for (const img of el.querySelectorAll('img'))
    if ((img as HTMLImageElement).naturalWidth > 8) return false
  for (const frame of el.querySelectorAll<HTMLIFrameElement>('iframe')) {
    const src = frame.src.toLowerCase()
    if (
      src &&
      !src.startsWith('about:') &&
      !AD_IFRAME_HINTS.some((h) => src.includes(h))
    )
      return false
  }
  // The only text allowed is the slot's own "AD"-style label.
  const text = (el.innerText ?? '').trim()
  return text === '' || SLOT_LABEL_RE.test(text)
}

function collapseEmptyAdSlots() {
  // Feature rides the same switch as the rest of cosmetic hiding; a user 👎
  // on .skip-sensei-empty-slot removes it from activeSelectors for the domain.
  if (!activeSelectors.includes(`.${EMPTY_SLOT_CLASS}`)) return
  // Name-based candidates: the element's OWN id/class declares it an ad slot.
  // Trusted even inside <header> — masthead billboard slots are a standard
  // news-site pattern (e.g. Business Insider's .masthead-ad) — because
  // isEmptyAdSlot still requires it to be an empty, non-interactive husk.
  const named = new Set<HTMLElement>()
  for (const el of document.querySelectorAll<HTMLElement>(
    'div[id*="ad" i], div[class*="ad" i], aside[id*="ad" i], aside[class*="ad" i], section[id*="ad" i], section[class*="ad" i]',
  )) {
    if (SLOT_NAME_RE.test(el.id) || SLOT_NAME_RE.test(el.className))
      named.add(el)
  }
  // Label-based candidates: a bare "AD" tag marks the slot; walk up to the
  // reserved box. These get the stricter no-nav/header guard since walking
  // up can overshoot into site chrome. (A box that also holds real content
  // fails the text check in isEmptyAdSlot, so overshooting stays safe.)
  const labelled = new Set<HTMLElement>()
  for (const label of document.querySelectorAll('span, div, p, small, b')) {
    if (label.children.length > 0) continue
    if (!SLOT_LABEL_RE.test((label.textContent ?? '').trim())) continue
    let box = label.parentElement
    for (let i = 0; i < 3 && box; i++) {
      if (box.getBoundingClientRect().height >= 60) {
        if (!named.has(box)) labelled.add(box)
        break
      }
      box = box.parentElement
    }
  }
  let tagged = 0
  const collapse = (el: HTMLElement, guard: string) => {
    if (el.classList.contains(EMPTY_SLOT_CLASS)) return
    if (el.closest(guard)) return
    if (isEmptyAdSlot(el)) {
      el.classList.add(EMPTY_SLOT_CLASS)
      tagged++
    }
  }
  for (const el of named) collapse(el, 'form')
  for (const el of labelled) collapse(el, 'nav, header, footer, form')
  if (tagged > 0) log('collapsed', tagged, 'empty ad slot(s)')
}

async function scheduleSlotCollapse() {
  if (!(await blockingActive())) return
  // Two passes: slots settle at different times (lazy ad scripts give up).
  setTimeout(collapseEmptyAdSlots, 2000)
  setTimeout(collapseEmptyAdSlots, 6000)
}

/** Human-readable summary of everything the extension is hiding on this page
 * (filter-list + YouTube + AI gap-fill), for the popup review. Capped so a
 * heavy ad page doesn't flood the popup. */
function describeHiddenElements() {
  const isYt = isYouTube()
  const sources: Array<{
    selector: string
    source: 'list' | 'ai' | 'youtube'
    vetoed?: boolean
  }> = [
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
    // AI proposals the safety guard kept visible — reviewable, not hidden.
    ...activeVetoed.map((selector) => ({
      selector,
      source: 'ai' as const,
      vetoed: true,
    })),
  ]
  const out = []
  for (const { selector, source, vetoed } of sources) {
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
      ...(vetoed ? { vetoed } : {}),
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
  await removeVetoedGapfill(domain, selector)
  const current = await getGapfillSelectors(domain)
  await setGapfillSelectors(
    domain,
    current.filter((s) => s !== selector),
  )
  await apply() // re-inject filter-list/YouTube style without it
  await applyGapfill() // and the gap-fill style → un-hides immediately
  reportGapfillFeedback(selector, 'not-ad')
}

/** User confirmed a hidden element is an ad — and, for a guard-vetoed
 * proposal, overrode the guard: hide it here from now on. */
async function confirmHiddenSelector(selector: string) {
  const domain = bareDomain()
  if (activeVetoed.includes(selector)) {
    await addConfirmedGapfill(domain, selector)
    await addGapfillSelectors(domain, [selector])
    await removeVetoedGapfill(domain, selector)
    await applyGapfill() // hides it immediately (confirmed skips the guard)
  }
  reportGapfillFeedback(selector, 'ad')
}

/**
 * Popup hover-highlight: outline the element(s) a review row refers to so the
 * user can see what they're rating. Hidden elements are temporarily revealed
 * (display:revert wins over the hide rules because this <style> comes later).
 * Driven over a port so the highlight clears the moment the popup closes.
 */
const HIGHLIGHT_STYLE_ID = 'skip-sensei-highlight'

function highlightSelector(selector: string | null) {
  document.getElementById(HIGHLIGHT_STYLE_ID)?.remove()
  if (!selector) return
  try {
    document.querySelector(selector)
  } catch {
    return // invalid selector — nothing to show
  }
  const style = document.createElement('style')
  style.id = HIGHLIGHT_STYLE_ID
  style.textContent = `${selector}{display:revert!important;outline:3px solid #7c3aed!important;outline-offset:2px!important;box-shadow:0 0 0 6px rgba(124,58,237,0.35)!important}`
  ;(document.head ?? document.documentElement).appendChild(style)
  const first = document.querySelector(selector)
  if (first) {
    const rect = first.getBoundingClientRect()
    const offscreen = rect.bottom < 0 || rect.top > window.innerHeight
    if (offscreen)
      first.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'skipSensei:highlight') return
  port.onMessage.addListener((msg: { selector?: string | null }) =>
    highlightSelector(msg?.selector ?? null),
  )
  port.onDisconnect.addListener(() => highlightSelector(null))
})

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
    void confirmHiddenSelector(message.selector).then(() =>
      sendResponse({ ok: true }),
    )
    return true // async response
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

/**
 * Ask the AI for ad selectors and process its proposals HERE, where the DOM
 * truth lives: the safety guard splits them into kept (hidden + cached) and
 * vetoed (kept visible, reviewable in the popup), and the activity log records
 * what actually happened — not what the AI claimed. Vetoed proposals persist
 * so the once-per-domain guard still holds when everything gets vetoed
 * (otherwise the purge re-empties the cache and the scan loops forever,
 * burning an LLM call per page load — the claude.ai bug).
 */
async function requestAndProcessProposals() {
  const domain = bareDomain()
  const html = collectAdSuspects()
  if (!html.trim()) {
    await setVetoedGapfill(domain, []) // nothing ad-like — remember we looked
    return
  }
  const proposals: string[] | null = await chrome.runtime
    .sendMessage({ type: 'skipSensei:findAdSelectors', html })
    .catch(() => null)
  if (proposals === null) return // transient failure — retry next visit
  const rejected = new Set(await getRejectedGapfill(domain))
  const valid = isValidSelectorList(proposals).filter((s) => !rejected.has(s))
  // A proposal that matches nothing RIGHT NOW is a hallucination artifact,
  // not a dormant ad rule — the AI was shown elements that exist. Caching it
  // would inject a selector that could silently start hiding real UI when an
  // SPA renders new content (telemetry: div[data-testid="page-header"] was
  // "kept" on claude.ai only because the real header is a <header> tag).
  const matching = valid.filter((s) => {
    try {
      return document.querySelector(s) !== null
    } catch {
      return false
    }
  })
  if (matching.length < valid.length)
    log('discarded', valid.length - matching.length, 'zero-match AI proposal(s)')
  const kept = matching.filter(isSafeGapfillSelector)
  const vetoed = matching.filter((s) => !kept.includes(s))
  if (kept.length > 0) await addGapfillSelectors(domain, kept)
  await setVetoedGapfill(domain, vetoed) // also marks the domain as scanned
  if (kept.length > 0) {
    log('gap-filler hid', kept.length, 'ad element(s):', kept)
    void recordActivity(
      'AI enhancements',
      `hid ${kept.length} ad element(s) the filter lists missed`,
      domain,
    )
  }
  if (vetoed.length > 0) {
    log('safety guard kept', vetoed.length, 'AI proposal(s) visible:', vetoed)
    void recordActivity(
      'AI enhancements',
      `AI flagged ${vetoed.length} element(s) but the safety guard kept them visible (they look like real UI) — rate them in the popup`,
      domain,
    )
  }
  if (kept.length + vetoed.length > 0) {
    // Which sites the lists miss, what the AI matched, and what the guard
    // refused — recurring patterns promote into shipped rules or prompt fixes.
    void chrome.runtime
      .sendMessage({
        type: 'skipSensei:event',
        kind: 'gapfill',
        fields: {
          domain,
          kept: kept.slice(0, 5).join(' , '),
          vetoed: vetoed.slice(0, 5).join(' , '),
        },
      })
      .catch(() => {})
  }
}

async function runGapfill() {
  if (!(await blockingActive())) return
  // YouTube is covered by curated selectors + the badge scanner; AI proposals
  // there risk the player (telemetry: it proposed #img and .style-scope).
  if (isYouTube()) return
  const settings = await getSettings()
  if (!settings.aiEnhancements) return
  // Already scanned this domain (kept selectors were applied on load, vetoed
  // ones await review in the popup) — don't spend another LLM call.
  if ((await getGapfillSelectors(bareDomain())).length > 0) return
  if ((await getVetoedGapfill(bareDomain())) !== null) return
  await requestAndProcessProposals()
  await applyGapfill()
}

/**
 * On-demand gap-filler for the popup "Scan for ads" button — ignores the
 * once-per-domain guard so the user can test the AI on any page and review
 * what it proposes. Returns the current hidden-element summary.
 */
async function scanForAds() {
  const settings = await getSettings()
  if (settings.aiEnhancements && !settings.localOnlyMode && !isYouTube()) {
    await requestAndProcessProposals()
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
  void scheduleSlotCollapse() // reclaim blank space where blocked ads were
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
