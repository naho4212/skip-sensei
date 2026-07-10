import { log } from '../log'
import {
  addConfirmedGapfill,
  addGapfillSelectors,
  addRejectedGapfill,
  clearRejectedGapfill,
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
  // Feed cards the global sponsored-card scanner tags by their disclosure
  // label (see scanSponsoredCards).
  '.skip-sensei-sponsored-card',
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

/** Placeholder mode: keep the slot's size, blank its content, and render the
 * AdBlockedSlot brand — for masonry layouts where collapsing would leave a
 * bare hole anyway. Pure CSS on purpose: these slots live inside React-owned
 * virtualized feeds that strip injected DOM children on every re-render (the
 * "some ads have no overlay" bug), but pseudo-elements are style-driven and
 * can't be removed. The two-tone wordmark comes from a background-clip
 * gradient split at the "AD "/"SENSEI" boundary. */
function buildPlaceholderCss(selectors: string[], dark: boolean): string {
  if (selectors.length === 0) return ''
  const slots = selectors.join(',')
  const children = selectors.map((s) => `${s} > *`).join(',')
  const boxes = selectors.map((s) => `${s}::before`).join(',')
  const marks = selectors.map((s) => `${s}::after`).join(',')
  const senseiColor = dark ? '#f1f1f1' : '#0c0c0c'
  return (
    `${slots}{position:relative!important}` +
    `${children}{visibility:hidden!important}` +
    `${boxes}{content:"";position:absolute;inset:0;border-radius:16px;` +
    `background:${dark ? 'rgba(124,58,237,0.05)' : 'rgba(124,58,237,0.04)'};` +
    `border:1px dashed ${dark ? 'rgba(241,241,241,0.14)' : 'rgba(12,12,12,0.14)'}}` +
    // 0.55, not the design system's 0.3: at 0.3 users read the card as an
    // unstyled blank hole (reported twice) — the mark has to say "handled".
    `${marks}{content:"AD SENSEI";position:absolute;inset:0;display:flex;` +
    `align-items:center;justify-content:center;` +
    `font:900 15px/1 Roboto,Arial,sans-serif;letter-spacing:-0.02em;` +
    `white-space:nowrap;opacity:0.55;pointer-events:none;` +
    `background:linear-gradient(90deg,#7c3aed 2.15ch,${senseiColor} 2.15ch);` +
    `-webkit-background-clip:text;background-clip:text;color:transparent}`
  )
}

// ---------------------------------------------------------------------------
// Blocked-ad slot branding — implements the design system's
// templates/ad-blocked-slot/AdBlockedSlot.dc.html: a subtle "AD SENSEI"
// wordmark + "ad skipped" note centered in the blanked slot, themed to the
// page. Injected as DOM (not ::after) because the wordmark is two-tone.
// ---------------------------------------------------------------------------

const SLOT_BRAND_CLASS = 'skip-sensei-slot-brand'

/** Empty ad slots whose space the page won't give back (see
 * collapseEmptyAdSlots): kept at size, contents blanked, brand overlay in. */
const BRANDED_SLOT_CLASS = 'skip-sensei-branded-slot'
const BRANDED_SLOT_CSS =
  `.${BRANDED_SLOT_CLASS}{position:relative!important}` +
  `.${BRANDED_SLOT_CLASS} > :not(.${SLOT_BRAND_CLASS}){visibility:hidden!important}`

/** Luminance of an element's background, or null if transparent/unparsable. */
function bgLuminance(el: Element | null): number | null {
  if (!el) return null
  const bg = getComputedStyle(el).backgroundColor
  const m = bg.match(
    /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)/,
  )
  if (!m) return null
  if (m[4] !== undefined && parseFloat(m[4]) === 0) return null // transparent
  return 0.2126 * +m[1] + 0.7152 * +m[2] + 0.0722 * +m[3]
}

function pageIsDark(): boolean {
  // body is often `transparent` (e.g. Pinterest) — fall through to <html>;
  // if both are transparent the page shows the white canvas → light.
  const lum =
    bgLuminance(document.body) ?? bgLuminance(document.documentElement)
  return lum !== null && lum < 128
}

/** Build the overlay per the AdBlockedSlot template (dark/light variants).
 * radius: 12px per the template; Pinterest passes 16 to match its cards. */
function buildSlotBrand(radius = 12): HTMLElement {
  const dark = pageIsDark()
  const overlay = document.createElement('div')
  overlay.className = SLOT_BRAND_CLASS
  overlay.style.cssText =
    'position:absolute;inset:0;box-sizing:border-box;display:flex;' +
    `align-items:center;justify-content:center;border-radius:${radius}px;` +
    `background:${dark ? 'rgba(124,58,237,0.05)' : 'rgba(124,58,237,0.04)'};` +
    `border:1px dashed ${dark ? 'rgba(241,241,241,0.14)' : 'rgba(12,12,12,0.14)'};` +
    'pointer-events:none;font-family:Roboto,Arial,sans-serif;'
  // The placeholder CSS hides all slot children; the overlay must opt out.
  overlay.style.setProperty('visibility', 'visible', 'important')

  const row = document.createElement('div')
  row.style.cssText =
    'display:flex;align-items:baseline;gap:10px;user-select:none;'
  const mark = document.createElement('div')
  mark.style.cssText =
    // 0.55 matches the placeholder mark — 0.3 read as a blank hole.
    'font-weight:900;letter-spacing:-0.02em;font-size:15px;line-height:1;' +
    'white-space:nowrap;opacity:0.55;'
  const ad = document.createElement('span')
  ad.style.color = '#7c3aed'
  ad.textContent = 'AD'
  const sensei = document.createElement('span')
  sensei.style.color = dark ? '#f1f1f1' : '#0c0c0c'
  sensei.textContent = ' SENSEI'
  mark.append(ad, sensei)
  const note = document.createElement('div')
  note.style.cssText =
    'font-size:11px;font-weight:400;letter-spacing:0.04em;' +
    `color:${dark ? 'rgba(241,241,241,0.45)' : 'rgba(12,12,12,0.45)'};`
  note.textContent = 'ad skipped'
  row.append(mark, note)
  overlay.append(row)
  return overlay
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

/**
 * Domain-specific cosmetic selectors from the bundled filter list, fetched
 * once per frame from the service worker (which owns the sharded data).
 *
 * Deliberately NOT awaited by apply(): the round-trip can wake a sleeping
 * worker, and blocking on it would delay the built-in selectors past the ad
 * paint they exist to prevent. apply() injects what it has, and re-applies
 * once the list lands — so the list only ever adds hiding, never postpones it.
 *
 * YouTube is excluded on purpose: its display ads are handled by
 * YOUTUBE_SELECTORS + the ad-badge scanner, which are tuned against the live
 * site, and we don't want list rules fighting them.
 *
 * A failure (worker asleep mid-navigation, message port closed) resolves to an
 * empty list rather than taking down the built-in selectors.
 */
let listSelectors: string[] | null = null
let listRequested = false

function requestListSelectors(onReady: () => void): void {
  if (listRequested) return
  listRequested = true
  if (isYouTube()) {
    listSelectors = []
    return
  }
  void chrome.runtime
    .sendMessage({
      type: 'skipSensei:getCosmeticFilters',
      hostname: location.hostname,
    })
    .then((selectors: unknown) =>
      Array.isArray(selectors) ? isValidSelectorList(selectors as string[]) : [],
    )
    .catch(() => [] as string[])
    .then((selectors) => {
      listSelectors = selectors
      if (selectors.length > 0) onReady()
    })
}

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
  // Domain-specific rules from the bundled list. Fetched in the background on
  // the first pass (see requestListSelectors) and folded in from the second;
  // validated on arrival because a rule can carry syntax this Chrome build
  // won't parse, and one bad selector in a comma-joined rule silently voids
  // the WHOLE stylesheet rule.
  if (genericOn) requestListSelectors(() => void apply())
  const hideSelectors = [
    ...(genericOn ? SELECTORS : []),
    ...(genericOn ? (listSelectors ?? []) : []),
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
      buildCss(hideSelectors) +
      buildPlaceholderCss(placeholderSelectors, pageIsDark()) +
      (genericOn ? BRANDED_SLOT_CSS : '')
    if (!existing) (document.head ?? document.documentElement).appendChild(style)
  }
  if (genericOn) void applyGapfill() // hide anything the AI found on prior visits

  if (ytOn) startAdBadgeScanner()
  else stopAdBadgeScanner()

  // Global disclosure-label scanner on the long tail; curated hosts have
  // precise site rules instead.
  if (genericOn && !isCuratedHost()) startSponsoredCardScanner()
  else stopSponsoredCardScanner()
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
/** Framework layout-utility class (Tailwind and kin). A selector built ONLY
 * from these says nothing about ad-ness and can match any div after the next
 * re-render — telemetry caught `div.flex.flex-col.gap-12` cached as an "ad"
 * on weather.com. */
const UTILITY_CLASS_RE =
  /^(flex|grid|block|inline(-\w+)?|relative|absolute|fixed|sticky|static|isolate|container|group|peer|truncate|hidden|visible|flex-\w+|grid-\w+|items-\w+|justify-\w+|content-\w+|self-\w+|place-\w+|gap(-\w+)?|space-[xy]-\w+|[pm][trblxyse]?-\w+|[wh]-\w+|min-[wh]-\w+|max-[wh]-\w+|size-\w+|text-\w+|font-\w+|leading-\w+|tracking-\w+|bg-\w+|border(-\w+)?|rounded(-\w+)?|shadow(-\w+)?|ring(-\w+)?|outline(-\w+)?|opacity-\w+|z-\w+|order-\w+|col(-\w+)?|row(-\w+)?|overflow(-\w+)?|object-\w+|transition(-\w+)?|duration-\w+|ease-\w+|cursor-\w+|select-\w+|pointer-events-\w+|sr-only|mx-auto|my-auto)$/

/** True when a `tag.a.b.c` selector's classes are all layout utilities. */
function isUtilityOnlySelector(sel: string): boolean {
  const m = sel.match(/^[a-z][a-z0-9]*((?:\.[A-Za-z][\w-]*)+)$/)
  if (!m) return false
  const classes = m[1].slice(1).split('.')
  return classes.every((c) => UTILITY_CLASS_RE.test(c))
}

function isSafeGapfillSelector(sel: string): boolean {
  if (isUtilityOnlySelector(sel)) return false
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
// camelCase ad tokens (weather.com's WX_Bot300AdX1). Deliberately
// case-SENSITIVE: with /i this would match "LoadTime"/"ReadMore".
const SLOT_NAME_CAMEL_RE = /(\d|[a-z])Ad[A-Z0-9]/
const SLOT_LABEL_RE = /^(ad|ads|advertisement|sponsored)$/i

function hasAdNameToken(s: string): boolean {
  return SLOT_NAME_RE.test(s) || SLOT_NAME_CAMEL_RE.test(s)
}

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
    if (!src || src.startsWith('about:')) continue
    if (AD_IFRAME_HINTS.some((h) => src.includes(h))) continue
    const fr = frame.getBoundingClientRect()
    if (fr.width < 8 || fr.height < 8) continue // invisible frame — no content
    // Same-origin frames (weather.com renders ads into first-party blob:
    // iframes) can be inspected: an empty document is still a husk.
    let empty = false
    try {
      const doc = frame.contentDocument
      empty =
        !!doc &&
        (doc.body?.innerText ?? '').trim() === '' &&
        ![...doc.images].some((i) => i.naturalWidth > 8)
    } catch {
      empty = false // cross-origin — assume it has content
    }
    if (!empty) return false
  }
  // The only text allowed is the slot's own "AD"-style label.
  const text = (el.innerText ?? '').trim()
  return text === '' || SLOT_LABEL_RE.test(text)
}

async function collapseEmptyAdSlots() {
  // Feature rides the same switch as the rest of cosmetic hiding; a user 👎
  // on .skip-sensei-empty-slot removes it from activeSelectors for the domain.
  if (!activeSelectors.includes(`.${EMPTY_SLOT_CLASS}`)) return
  // 👎 on the branded-slot entry: keep collapsing, stop branding here.
  const brandAllowed = !(await getRejectedGapfill(bareDomain())).includes(
    `.${BRANDED_SLOT_CLASS}`,
  )
  // Name-based candidates: the element's OWN id/class declares it an ad slot.
  // Trusted even inside <header> — masthead billboard slots are a standard
  // news-site pattern (e.g. Business Insider's .masthead-ad) — because
  // isEmptyAdSlot still requires it to be an empty, non-interactive husk.
  const named = new Set<HTMLElement>()
  for (const el of document.querySelectorAll<HTMLElement>(
    'div[id*="ad" i], div[class*="ad" i], aside[id*="ad" i], aside[class*="ad" i], section[id*="ad" i], section[class*="ad" i]',
  )) {
    if (hasAdNameToken(el.id) || hasAdNameToken(el.className)) named.add(el)
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
  let branded = 0
  const collapse = (el: HTMLElement, guard: string) => {
    if (el.classList.contains(BRANDED_SLOT_CLASS)) {
      // Self-heal: re-add the overlay if something stripped it.
      if (!el.querySelector(`:scope > .${SLOT_BRAND_CLASS}`))
        el.appendChild(buildSlotBrand())
      return
    }
    if (el.classList.contains(EMPTY_SLOT_CLASS)) return
    if (el.closest(guard)) return
    if (!isEmptyAdSlot(el)) return
    // Collapse, then check the page actually reclaimed the space. A slot in
    // a fixed rail (the parent still reserves the area) collapses into dead
    // white space — there, fill the slot with the branded AdBlockedSlot
    // instead so the void reads as intentional.
    const parent = el.parentElement
    const before = parent?.getBoundingClientRect().height ?? 0
    el.classList.add(EMPTY_SLOT_CLASS)
    const after = parent?.getBoundingClientRect().height ?? 0
    if (parent && before - after < 40) {
      el.classList.remove(EMPTY_SLOT_CLASS)
      if (!brandAllowed) return // user 👎'd the card here — leave the slot be
      el.classList.add(BRANDED_SLOT_CLASS)
      if (!el.querySelector(`:scope > .${SLOT_BRAND_CLASS}`))
        el.appendChild(buildSlotBrand())
      branded++
    } else {
      tagged++
    }
  }
  for (const el of named) collapse(el, 'form')
  for (const el of labelled) collapse(el, 'nav, header, footer, form')
  if (tagged + branded > 0)
    log('empty ad slots — collapsed:', tagged, 'branded:', branded)
}

let collapseObserver: MutationObserver | null = null
let collapsePassScheduled = false

/** Debounced collapse pass for slots that render AFTER the load-time passes —
 * infinite scroll and lazy ad scripts insert reserved boxes minutes in. */
function scheduleCollapsePass() {
  if (collapsePassScheduled) return
  collapsePassScheduled = true
  setTimeout(() => {
    collapsePassScheduled = false
    void collapseEmptyAdSlots()
  }, 1500)
}

async function scheduleSlotCollapse() {
  if (!(await blockingActive())) return
  // Two passes: slots settle at different times (lazy ad scripts give up).
  setTimeout(() => void collapseEmptyAdSlots(), 2000)
  setTimeout(() => void collapseEmptyAdSlots(), 6000)
  // Then keep watching: lazy-rendered slots (scroll-triggered ad units) enter
  // the DOM long after both passes. collapseEmptyAdSlots gates itself on the
  // feature selector being active, so the observer is inert when it's off.
  if (collapseObserver) return
  collapseObserver = new MutationObserver(() => scheduleCollapsePass())
  collapseObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
  })
}

// ---------------------------------------------------------------------------
// Global sponsored-card scanner. The one ad signal that generalizes to every
// site and language is the legally-mandated disclosure label ("Sponsored",
// "Anzeige", "広告", …). Find exact-text labels, climb to the containing FEED
// CARD — verified by the one-of-several-similar-siblings pattern, which is
// what bounds the blast radius: a wrong match costs one card in a feed, never
// a page section — and hide it via the stylesheet. Curated hosts (YouTube +
// the first-party table) are excluded; they have precise site rules. Runs
// continuously like the YouTube badge scanner, so cards that stream in later
// are caught too. Recovery: the popup review lists tagged cards; 👎 un-hides
// and disables the scanner for the domain.
// ---------------------------------------------------------------------------

const SPONSORED_CARD_CLASS = 'skip-sensei-sponsored-card'

function isCuratedHost(): boolean {
  return (
    isYouTube() ||
    FIRST_PARTY_AD_SITES.some((site) => site.hosts.test(location.hostname))
  )
}

/** Climb from a disclosure label to the feed card it discloses, or null when
 * no bounded card presents itself — then we leave it alone (fail open). */
function findSponsoredFeedCard(label: Element): HTMLElement | null {
  if (
    label.closest(
      'nav, header, footer, form, [role="navigation"], [role="banner"], [role="menu"], [role="menubar"]',
    )
  )
    return null
  const lr = label.getBoundingClientRect()
  // Ad badges are small; a headline-sized "Sponsored" is content, not a badge.
  if (lr.width === 0 || lr.height === 0 || lr.height > 40) return null
  let node = label.parentElement
  for (let i = 0; i < 7 && node; i++, node = node.parentElement) {
    const r = node.getBoundingClientRect()
    if (r.height > 1200) return null // grew past card size — give up
    if (r.height < 80 || r.width < 120) continue
    if (
      r.width >= window.innerWidth * 0.98 &&
      r.height >= window.innerHeight * 0.8
    )
      return null // page section, not a card
    const parent = node.parentElement
    if (!parent) return null
    // The feed-card pattern: this element is one of several same-tag
    // siblings (organic cards around the ad).
    const similar = [...parent.children].filter(
      (c) => c.tagName === node!.tagName,
    )
    if (similar.length >= 3) {
      if (node.querySelector('input, select, textarea')) return null
      return node
    }
  }
  return null
}

function scanSponsoredCards() {
  if (!document.body) return
  if (!activeSelectors.includes(`.${SPONSORED_CARD_CLASS}`)) return
  let tagged = 0
  for (const label of document.querySelectorAll('span, div, p, small, b, em')) {
    if (label.children.length > 0) continue
    if (!DISCLOSURE_LABEL_RE.test((label.textContent ?? '').trim())) continue
    const card = findSponsoredFeedCard(label)
    if (card && !card.classList.contains(SPONSORED_CARD_CLASS)) {
      card.classList.add(SPONSORED_CARD_CLASS)
      tagged++
      log('sponsored-card scanner hid a labelled card:', card.tagName)
    }
  }
  if (tagged > 0) {
    void recordActivity(
      'Block all ads',
      `hid ${tagged} sponsored post(s) by their ad label`,
      bareDomain(),
    )
    // Mining data: which long-tail domains carry labelled first-party ads —
    // recurring ones can be promoted into shipped per-site rules.
    void chrome.runtime
      .sendMessage({
        type: 'skipSensei:event',
        kind: 'sponsored_card',
        fields: { domain: bareDomain(), count: String(tagged) },
      })
      .catch(() => {})
  }
}

let sponsoredObserver: MutationObserver | null = null
let sponsoredScanScheduled = false

function scheduleSponsoredScan() {
  if (sponsoredScanScheduled) return
  sponsoredScanScheduled = true
  setTimeout(() => {
    sponsoredScanScheduled = false
    scanSponsoredCards()
  }, 800)
}

function startSponsoredCardScanner() {
  scanSponsoredCards()
  if (sponsoredObserver) return
  sponsoredObserver = new MutationObserver(() => scheduleSponsoredScan())
  sponsoredObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
  })
}

function stopSponsoredCardScanner() {
  sponsoredObserver?.disconnect()
  sponsoredObserver = null
  document
    .querySelectorAll(`.${SPONSORED_CARD_CLASS}`)
    .forEach((el) => el.classList.remove(SPONSORED_CARD_CLASS))
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
    // Collapser results get friendlier synthetic entries below.
    if (selector === `.${EMPTY_SLOT_CLASS}`) continue
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
  // Empty-slot collapser outcomes, so "13 slots handled" never reads as
  // "nothing hidden here" in the popup.
  const collapsed = document.querySelectorAll(`.${EMPTY_SLOT_CLASS}`).length
  if (collapsed > 0 && activeSelectors.includes(`.${EMPTY_SLOT_CLASS}`))
    out.push({
      selector: `.${EMPTY_SLOT_CLASS}`,
      source: 'list' as const,
      count: collapsed,
      tag: 'div',
      text: 'Empty ad slot — collapsed, content moved up',
    })
  const brandedSlots = document.querySelectorAll(`.${BRANDED_SLOT_CLASS}`).length
  if (brandedSlots > 0)
    out.push({
      selector: `.${BRANDED_SLOT_CLASS}`,
      source: 'list' as const,
      count: brandedSlots,
      tag: 'div',
      text: 'Empty ad slot — filled with the Ad Sensei card',
    })
  return out
}

/** User marked a hidden selector "not an ad": un-hide it, block it here for
 * good, and report the correction. */
async function rejectHiddenSelector(selector: string) {
  const domain = bareDomain()
  await addRejectedGapfill(domain, selector)
  await removeVetoedGapfill(domain, selector)
  // Scanner/collapser outcomes: un-tag every element right now (the rejected
  // list stops future passes via the activeSelectors gate).
  if (
    selector === `.${EMPTY_SLOT_CLASS}` ||
    selector === `.${BRANDED_SLOT_CLASS}` ||
    selector === `.${SPONSORED_CARD_CLASS}`
  ) {
    for (const el of document.querySelectorAll(selector)) {
      el.classList.remove(
        EMPTY_SLOT_CLASS,
        BRANDED_SLOT_CLASS,
        SPONSORED_CARD_CLASS,
      )
      el.querySelector(`:scope > .${SLOT_BRAND_CLASS}`)?.remove()
    }
  }
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
  // This script runs in every iframe. Only the top frame owns the popup
  // conversation — a subframe answering first would hand the popup its own
  // (empty) hidden-elements list, and confirm/reject would write feedback
  // under the iframe's domain instead of the site's.
  if (window !== window.top) return
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
  } else if (message?.type === 'skipSensei:getSiteFeedback') {
    void getRejectedGapfill(bareDomain()).then((rejected) =>
      sendResponse({ rejectedCount: rejected.length }),
    )
    return true // async response
  } else if (message?.type === 'skipSensei:resetSiteFeedback') {
    void resetSiteFeedback().then(sendResponse)
    return true // async response
  }
})

/** Undo every 👎 on this domain: re-enable the un-hidden selectors and any
 * feature (collapser, sponsored-card scanner) a rating switched off, re-run
 * them, and hand back the fresh review list. */
async function resetSiteFeedback() {
  await clearRejectedGapfill(bareDomain())
  await apply() // rebuilds activeSelectors + styles, re-applies gapfill
  await collapseEmptyAdSlots()
  scanSponsoredCards()
  return describeHiddenElements()
}

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
  // The badge is last-write-wins per tab: a subframe's "false" (its tiny DOM
  // has no ad iframes) must not clobber the top frame's "true". Subframes may
  // only ever ADD a reload hint.
  if (window !== window.top && !needsReload) return
  chrome.runtime
    .sendMessage({ type: 'skipSensei:tabNeedsReload', needsReload })
    .catch(() => {})
}

function scheduleReloadChecks() {
  setTimeout(() => void reportReloadState(), 1500)
  setTimeout(() => void reportReloadState(), 4000)
}

// ---------------------------------------------------------------------------
// AI gap-filler v2: deterministic candidates, AI verification.
//
// The old design asked the AI to FIND ads in suspect HTML and hand back CSS
// selectors. Telemetry showed it hallucinating site UI as "ads" on ~15
// domains (headers, sign-up buttons, job listings, a form input) — the
// safety guard was all that stood between it and hiding real content. Now:
//   1. Deterministic rules build the candidate set from hard ad signals
//      (ad-network iframe, ad/sponsor name token, exact "Sponsored" label).
//   2. WE generate the selector for each candidate — the AI never supplies
//      CSS.
//   3. The AI's only power is a veto: "is candidate #n an ad? unsure → no."
// Every failure mode fails toward "an ad might show", never "real UI hidden".
// No candidates → no LLM call at all (this is what keeps claude.ai quiet).
// ---------------------------------------------------------------------------

/** Ad/sponsor name as a TOKEN — substring matching is how "download" used to
 * become an ad suspect (…downlo-AD…). */
const CANDIDATE_NAME_RE =
  /(^|[-_ ])(ads?|advert(isement)?s?|sponsored?|promoted)([-_ ]|$)/i
/**
 * Exact ad-disclosure label text (leaf nodes only), across common locales.
 * This is the one ad signal that generalizes to EVERY site: disclosure
 * labels are legally mandated almost everywhere ads run. Exact match only —
 * an article about sponsorship never consists solely of the word.
 */
const DISCLOSURE_LABEL_RE =
  /^(sponsored|promoted|advertisement|paid (content|post|partnership)|anzeige|gesponsert|sponsorisé|publicité|commandité|patrocinado|publicidad|sponsorizzato|pubblicità|gesponsord|advertentie|annons|annonse|reklama|реклама|广告|贊助|広告|スポンサー|스폰서|광고)$/i

/** Deterministic not-UI filter, applied to candidate ELEMENTS before the AI
 * ever sees them. Mirrors isSafeGapfillSelector but works on the element. */
function isSafeCandidate(el: HTMLElement): boolean {
  if (
    el.matches(
      'a, button, nav, header, footer, main, input, select, textarea, form, label, fieldset, body, html',
    )
  )
    return false
  if (
    el.closest(
      'form, nav, header, footer, [role="navigation"], [role="banner"], [role="menu"], [role="menubar"]',
    )
  )
    return false
  if (el.querySelector('input, select, textarea')) return false
  const r = el.getBoundingClientRect()
  if (r.width < 60 || r.height < 20 || r.height > 1200) return false
  // A near-viewport-sized box is a page section, not an ad unit.
  if (r.width >= window.innerWidth * 0.98 && r.height >= window.innerHeight * 0.8)
    return false
  return true
}

/** Generate OUR selector for a candidate — id, then stable classes, then a
 * data attribute. Returns null when there's no stable handle: we skip the
 * candidate rather than build a brittle positional path. */
function selectorFor(el: HTMLElement): string | null {
  if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) {
    const s = `#${CSS.escape(el.id)}`
    if (document.querySelectorAll(s).length === 1) return s
  }
  const classes = [...el.classList]
    .filter((c) => /^[A-Za-z][\w-]*$/.test(c) && !c.startsWith('skip-sensei'))
    .slice(0, 4)
  // At least one class must be semantic — a handle made only of layout
  // utilities (.flex.gap-12) matches different elements every re-render.
  if (classes.length > 0 && !classes.every((c) => UTILITY_CLASS_RE.test(c))) {
    const s = `${el.tagName.toLowerCase()}.${classes.map((c) => CSS.escape(c)).join('.')}`
    const matches = document.querySelectorAll(s)
    // >1 match is fine — repeated units of the same ad widget — but a broad
    // selector is a miss, not a candidate.
    if (matches.length >= 1 && matches.length <= 6) return s
  }
  for (const attr of ['data-testid', 'data-test-id', 'data-component-type']) {
    const v = el.getAttribute(attr)
    if (v && v.length <= 60) {
      const s = `${el.tagName.toLowerCase()}[${attr}="${v.replace(/"/g, '\\"')}"]`
      try {
        const matches = document.querySelectorAll(s)
        if (matches.length >= 1 && matches.length <= 6) return s
      } catch {
        /* unusable attribute value */
      }
    }
  }
  return null
}

interface GapfillCandidate {
  el: HTMLElement
  selector: string
}

function collectAdCandidates(
  excluded: Set<string>,
): GapfillCandidate[] {
  const out: GapfillCandidate[] = []
  const seen = new Set<Element>()
  const taken = new Set<string>()
  const push = (el: Element | null) => {
    if (!(el instanceof HTMLElement) || seen.has(el) || out.length >= 12) return
    seen.add(el)
    // Already handled by the collapser — nothing left to decide.
    if (el.closest(`.${EMPTY_SLOT_CLASS}, .${BRANDED_SLOT_CLASS}`)) return
    if (!isSafeCandidate(el)) return
    const selector = selectorFor(el)
    if (!selector || excluded.has(selector) || taken.has(selector)) return
    taken.add(selector)
    out.push({ el, selector })
  }
  // 1. Containers of ad-network iframes the DNR lists let through.
  for (const frame of document.querySelectorAll<HTMLIFrameElement>('iframe[src]')) {
    const src = frame.src.toLowerCase()
    if (AD_IFRAME_HINTS.some((h) => src.includes(h)))
      push(frame.parentElement ?? frame)
  }
  // 2. Ad/sponsor-named containers (token match).
  for (const el of document.querySelectorAll<HTMLElement>(
    'div[class*="ad" i], div[id*="ad" i], section[class*="ad" i], section[id*="ad" i], div[class*="spons" i], div[class*="promo" i], section[class*="spons" i], article[class*="spons" i], aside[class*="ad" i], li[class*="spons" i], li[class*="ad" i]',
  )) {
    if (out.length >= 12) break
    if (
      CANDIDATE_NAME_RE.test(el.id) ||
      CANDIDATE_NAME_RE.test(el.getAttribute('class') ?? '')
    )
      push(el)
  }
  // 3. Cards carrying an exact ad-disclosure label ("Sponsored", …).
  for (const label of document.querySelectorAll('span, div, p, small, b, em')) {
    if (out.length >= 12) break
    if (label.children.length > 0) continue
    if (!DISCLOSURE_LABEL_RE.test((label.textContent ?? '').trim())) continue
    let card = label.parentElement
    for (let i = 0; i < 4 && card; i++) {
      const r = card.getBoundingClientRect()
      if (r.height >= 60 && r.height <= 1000 && r.width >= 120) break
      card = card.parentElement
    }
    push(card)
  }
  return out
}

/**
 * Gap-filler v2 pipeline: deterministic candidates → AI veto → hide the
 * confirmed ones. AI-declined candidates persist as "vetoed" (reviewable in
 * the popup with 👍 to override) and mark the domain as scanned so the
 * once-per-domain guard holds even when nothing gets hidden.
 */
async function requestAndProcessProposals() {
  const domain = bareDomain()
  const rejected = await getRejectedGapfill(domain)
  const cached = await getGapfillSelectors(domain)
  const excluded = new Set([...rejected, ...cached])
  const candidates = collectAdCandidates(excluded)
  if (candidates.length === 0) {
    await setVetoedGapfill(domain, []) // nothing ad-like — remember we looked
    return
  }
  const verdict: number[] | null = await chrome.runtime
    .sendMessage({
      type: 'skipSensei:verifyAdCandidates',
      candidates: candidates.map((c, index) => ({
        index,
        html: c.el.outerHTML.slice(0, 700),
      })),
    })
    .catch(() => null)
  if (verdict === null) return // transient failure — retry next visit
  const approved = new Set(verdict)
  const kept = candidates.filter((_, i) => approved.has(i)).map((c) => c.selector)
  const vetoed = candidates
    .filter((_, i) => !approved.has(i))
    .map((c) => c.selector)
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
    log('AI declined', vetoed.length, 'ad candidate(s):', vetoed)
    void recordActivity(
      'AI enhancements',
      `${vetoed.length} ad-like element(s) stayed visible — the AI wasn't sure they're ads. Rate them in the popup`,
      domain,
    )
  }
  // Which sites the lists miss and what the AI confirmed vs declined —
  // recurring patterns promote into shipped rules or prompt fixes.
  void chrome.runtime
    .sendMessage({
      type: 'skipSensei:event',
      kind: 'gapfill',
      fields: {
        domain,
        candidates: String(candidates.length),
        kept: kept.slice(0, 5).join(' , '),
        vetoed: vetoed.slice(0, 5).join(' , '),
      },
    })
    .catch(() => {})
}

async function runGapfill() {
  // Top frame only: each ad iframe would otherwise run its own scan — extra
  // LLM calls, and results stored under the IFRAME's domain, not the site's.
  if (window !== window.top) return
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
