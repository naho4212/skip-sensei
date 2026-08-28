/**
 * One-time in-page notice for YouTube: ads here are SKIPPED as they start
 * (stream-stitched, never blocked) and sponsor reads are skipped too; the
 * first-party beta strips most ads before they start. Small card under the
 * masthead, right side, so it never covers the player or search box;
 * "Got it" / × dismisses it for good. The popup's Home tab shows the same
 * note on youtube.com and shares this key, so clearing one clears both.
 */
export const YOUTUBE_NOTE_KEY = 'youtubeNoteDismissed'

const ID = 'skip-sensei-youtube-notice'
const STYLE_ID = `${ID}-style`
const ACCENT = '#7c3aed'
const CSS = `
#${ID} {
  position: fixed;
  top: 68px;
  right: 16px;
  z-index: 2147483000;
  width: 360px;
  max-width: calc(100vw - 32px);
  box-sizing: border-box;
  padding: 12px 34px 12px 14px;
  border-radius: 12px;
  background: #0f0f0f;
  border: 1px solid rgba(124, 58, 237, 0.55);
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.55);
  color: #fff;
  font: 400 13px/1.45 "Roboto", "Arial", sans-serif;
  opacity: 0;
  transform: translateY(-6px);
  transition: opacity 0.25s, transform 0.25s;
}
#${ID}.skip-sensei-visible { opacity: 1; transform: translateY(0); }
#${ID} .ss-title {
  display: flex; align-items: center; gap: 8px; white-space: nowrap;
  font-weight: 700; font-size: 13.5px; margin-bottom: 4px;
}
#${ID} .ss-title::before {
  content: ""; width: 7px; height: 7px; border-radius: 50%; flex: none;
  background: #ff0033; box-shadow: 0 0 8px #ff0033;
}
#${ID} .ss-title b { color: #a78bfa; font-weight: 700; }
#${ID} .ss-brand { font-size: 10.5px; font-weight: 600; letter-spacing: 0.08em; color: #aaa; align-self: center; }
#${ID} p { margin: 0; color: #d6d6d6; }
#${ID} p b { color: #fff; }
#${ID} .ss-actions { margin-top: 10px; display: flex; justify-content: space-between; align-items: center; }
#${ID} .ss-ok {
  border: 0; border-radius: 999px; padding: 6px 14px; cursor: pointer;
  background: ${ACCENT}; color: #fff; font: 700 12.5px/1 inherit;
}
#${ID} .ss-ok:hover { background: #8b5cf6; }
#${ID} .ss-x {
  position: absolute; top: 6px; right: 6px; width: 24px; height: 24px;
  border: 0; border-radius: 6px; background: transparent; color: #aaa;
  font-size: 18px; line-height: 1; cursor: pointer;
}
#${ID} .ss-x:hover { color: #fff; background: rgba(255,255,255,0.08); }
`

export async function showYouTubeNotice(): Promise<void> {
  if (document.getElementById(ID)) return
  try {
    const stored = await chrome.storage.local.get(YOUTUBE_NOTE_KEY)
    if (stored[YOUTUBE_NOTE_KEY] === true) return
  } catch {
    return
  }
  if (!document.body) {
    document.addEventListener('DOMContentLoaded', () => void showYouTubeNotice(), { once: true })
    return
  }
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = CSS
    document.documentElement.appendChild(style)
  }
  // Built with DOM APIs, not innerHTML: youtube.com enforces Trusted Types
  // (require-trusted-types-for 'script'), which rejects innerHTML from
  // content scripts too.
  const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    cls?: string,
    text?: string,
  ): HTMLElementTagNameMap[K] => {
    const n = document.createElement(tag)
    if (cls) n.className = cls
    if (text !== undefined) n.textContent = text
    return n
  }
  const card = el('div')
  card.id = ID
  card.setAttribute('role', 'status')
  const x = el('button', 'ss-x', '×')
  x.type = 'button'
  x.setAttribute('aria-label', 'Dismiss')
  const title = el('div', 'ss-title')
  const titleSpan = el('span')
  titleSpan.append('YouTube ads are ', el('b', undefined, 'skipped'), ', not blocked')
  title.append(titleSpan)
  const p = el('p')
  p.append(
    'Ads are stitched into the stream, so Ad Sensei skips each one the moment it starts (about a second, not thirty) and skips sponsor reads too. Want most ads to never start? Turn on ',
    el('b', undefined, 'Block first-party ads (beta)'),
    ' in the Ad Sensei popup under Controls \u2192 YouTube.',
  )
  const actions = el('div', 'ss-actions')
  const ok = el('button', 'ss-ok', 'Got it')
  ok.type = 'button'
  actions.append(el('span', 'ss-brand', 'AD SENSEI'), ok)
  card.append(x, title, p, actions)
  const dismiss = () => {
    card.classList.remove('skip-sensei-visible')
    setTimeout(() => card.remove(), 250)
    void chrome.storage.local.set({ [YOUTUBE_NOTE_KEY]: true }).catch(() => {})
  }
  x.addEventListener('click', dismiss)
  ok.addEventListener('click', dismiss)
  document.body.appendChild(card)
  requestAnimationFrame(() => card.classList.add('skip-sensei-visible'))
}
