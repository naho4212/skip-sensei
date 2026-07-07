import { log } from '../log'
import {
  getGapfillSelectors,
  getSettings,
  onSettingsChanged,
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

async function apply() {
  const on = await blockingActive()

  const existing = document.getElementById(STYLE_ID)
  if (on && !existing) {
    const style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = buildCss(SELECTORS)
    ;(document.head ?? document.documentElement).appendChild(style)
    void applyGapfill() // hide anything the AI found on prior visits
  } else if (!on && existing) {
    existing.remove()
    document.getElementById(GAPFILL_STYLE_ID)?.remove()
  }
}

/** Apply this domain's AI-discovered ad selectors (from prior visits). */
async function applyGapfill() {
  const cached = isValidSelectorList(await getGapfillSelectors(bareDomain()))
  if (cached.length === 0) return
  let style = document.getElementById(GAPFILL_STYLE_ID) as HTMLStyleElement | null
  if (!style) {
    style = document.createElement('style')
    style.id = GAPFILL_STYLE_ID
    ;(document.head ?? document.documentElement).appendChild(style)
  }
  style.textContent = buildCss(cached)
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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'skipSensei:pageHasAds') {
    sendResponse(pageHasLoadedAds())
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

function onPageReady() {
  scheduleReloadChecks()
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
