import { log } from '../log'
import {
  addGapfillSelectors,
  getGapfillSelectors,
  getSettings,
} from '../storage'

/**
 * AI cookie-consent auto-answer. When "Hide cookie-consent notices" is on with
 * AI enhancements, instead of just hiding the banner (which doesn't actually
 * record a choice), find the "Reject all / necessary only" button and click it
 * — so your privacy preference is genuinely registered and the banner closes
 * itself. The clicked selector is cached per domain (via the gapfill store,
 * key prefix "consent:") so return visits are instant with no AI call.
 *
 * Safety: the AI is instructed to NEVER return an "Accept" button, and we only
 * click elements whose text isn't accept-like. Worst case (no reject found),
 * we do nothing and the cookie-notices filter list still hides the banner.
 */

const CONSENT_HINTS = [
  '#onetrust-banner-sdk',
  '#onetrust-consent-sdk',
  '.cc-window',
  '#cookie-banner',
  '#cookie-consent',
  '#cookieConsent',
  '[id*="cookie" i][class*="banner" i]',
  '[class*="cookie" i][class*="consent" i]',
  '[class*="cookie" i][class*="banner" i]',
  '[class*="gdpr" i]',
  '[aria-label*="cookie" i]',
  '[data-testid*="cookie" i]',
]

const ACCEPT_RE = /\b(accept|agree|allow all|got it|ok|okay|continue|i understand)\b/i
let handled = false

function findBanner(): HTMLElement | null {
  for (const sel of CONSENT_HINTS) {
    let el: HTMLElement | null = null
    try {
      el = document.querySelector<HTMLElement>(sel)
    } catch {
      continue
    }
    if (el && el.offsetParent !== null && el.offsetHeight > 30) return el
  }
  return null
}

function clickReject(banner: HTMLElement, selector: string): boolean {
  let btn: HTMLElement | null = null
  try {
    btn = banner.querySelector<HTMLElement>(selector) ?? document.querySelector<HTMLElement>(selector)
  } catch {
    return false
  }
  if (!btn || btn.offsetParent === null) return false
  // Never click something that reads as "accept".
  if (ACCEPT_RE.test((btn.textContent ?? '').trim())) return false
  btn.click()
  return true
}

const cacheKey = () => 'consent:' + location.hostname.replace(/^www\./, '')

async function handleConsent() {
  if (handled) return
  const settings = await getSettings()
  const host = location.hostname
  const allowed =
    settings.allowlist.includes(host) ||
    settings.allowlist.includes(host.replace(/^www\./, ''))
  if (
    !settings.masterEnabled ||
    !settings.blockAllAds ||
    !settings.blockCookieNotices ||
    !settings.aiEnhancements ||
    allowed
  ) {
    return
  }

  const banner = findBanner()
  if (!banner) return
  handled = true

  // Cached reject selector for this domain → click instantly, no AI call.
  const cached = await getGapfillSelectors(cacheKey())
  for (const sel of cached) {
    if (clickReject(banner, sel)) {
      log('consent: clicked cached reject')
      return
    }
  }

  const selector: string | null = await chrome.runtime
    .sendMessage({
      type: 'skipSensei:findConsentReject',
      html: banner.outerHTML.slice(0, 5000),
    })
    .catch(() => null)
  if (selector && clickReject(banner, selector)) {
    log('consent: AI found & clicked reject:', selector)
    await addGapfillSelectors(cacheKey(), [selector])
  }
}

export function initConsent() {
  handled = false
  // Banners often appear a beat after load; sample a couple of times.
  setTimeout(() => void handleConsent(), 1200)
  setTimeout(() => void handleConsent(), 3500)
}
