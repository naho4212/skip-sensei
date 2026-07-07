import { log } from '../log'
import { getSettings } from '../storage'

/**
 * AI-reviewed popup/overlay blocking. When "Block popup & overlay ads" is on
 * with AI enhancements, watches for large overlays that appear after load and
 * asks the AI whether each is an intrusive annoyance (newsletter wall, promo,
 * ad) — which it hides — or something functional (login, consent, checkout) —
 * which it keeps.
 *
 * Safety first: overlays that are obviously functional (contain a password
 * field, a form, or an auth iframe) are NEVER touched — no AI call, always
 * kept. On any AI failure or uncertainty, the overlay is kept. The goal is to
 * never break a login or consent flow.
 */

const REVIEWED = new WeakSet<Element>()
let observer: MutationObserver | null = null

/** Auth/functional signals — if an overlay has any, keep it without asking the AI. */
function isFunctional(el: Element): boolean {
  if (el.querySelector('input[type="password"], input[type="email"], form')) {
    return true
  }
  if (
    el.querySelector(
      'iframe[src*="accounts.google"], iframe[src*="appleid.apple"], iframe[src*="facebook.com"], iframe[src*="login"], iframe[src*="auth"], iframe[src*="checkout"], iframe[src*="stripe"], iframe[src*="paypal"]',
    )
  ) {
    return true
  }
  const text = (el.textContent ?? '').toLowerCase().slice(0, 400)
  return /\b(sign in|log ?in|password|verify|checkout|payment|two-factor|2fa)\b/.test(
    text,
  )
}

/** Is this a big, blocking overlay worth reviewing (vs. normal page content)? */
function isOverlayCandidate(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return false
  const style = getComputedStyle(el)
  if (style.position !== 'fixed' && style.position !== 'absolute') return false
  if (style.display === 'none' || style.visibility === 'hidden') return false
  const z = parseInt(style.zIndex, 10)
  const rect = el.getBoundingClientRect()
  const coversLots =
    rect.width * rect.height > window.innerWidth * window.innerHeight * 0.15
  const looksModal =
    /modal|overlay|popup|dialog|lightbox|interstitial|newsletter|subscribe/i.test(
      el.className.toString() + ' ' + el.id,
    )
  return (coversLots && (z > 100 || looksModal)) || (looksModal && rect.height > 120)
}

async function review(el: Element) {
  if (REVIEWED.has(el)) return
  REVIEWED.add(el)
  if (isFunctional(el)) return // never touch logins / consent / checkout

  const html = (el as HTMLElement).outerHTML.slice(0, 4000)
  const hide: boolean | null = await chrome.runtime
    .sendMessage({ type: 'skipSensei:reviewPopup', html })
    .catch(() => null)
  if (hide && el.isConnected) {
    ;(el as HTMLElement).style.setProperty('display', 'none', 'important')
    log('AI hid an intrusive popup')
  }
}

let scanTimer: number | null = null
function scheduleScan() {
  if (scanTimer !== null) return
  scanTimer = window.setTimeout(() => {
    scanTimer = null
    // Review top-level positioned overlays only (not every nested node).
    for (const el of document.body?.children ?? []) {
      if (isOverlayCandidate(el)) void review(el)
    }
  }, 600)
}

async function start() {
  const settings = await getSettings()
  const on =
    settings.masterEnabled &&
    settings.blockAllAds &&
    settings.blockPopups &&
    settings.aiEnhancements
  const host = location.hostname
  const allowed =
    settings.allowlist.includes(host) ||
    settings.allowlist.includes(host.replace(/^www\./, ''))

  if (!on || allowed) {
    observer?.disconnect()
    observer = null
    return
  }
  if (observer) return
  observer = new MutationObserver(scheduleScan)
  observer.observe(document.documentElement, { childList: true, subtree: true })
  scheduleScan()
}

export function initPopupReviewer() {
  void start()
}
