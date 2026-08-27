/**
 * One-time in-page notice for the Spotify web player: ads here are MUTED, not
 * blocked or skipped (in-stream delivery, skip locked server-side — see
 * audio-ads.ts). Shown as a small card under Spotify's top bar so it never
 * covers the search box or player controls; "Got it" / × dismisses it for
 * good. The popup shows the same notice and shares the dismissal key, so
 * clearing one clears both.
 */
export const SPOTIFY_NOTE_KEY = 'spotifyNoteDismissed'

const ID = 'skip-sensei-spotify-notice'
const STYLE_ID = `${ID}-style`
const CSS = `
#${ID} {
  position: fixed;
  top: 76px;
  right: 16px;
  z-index: 2147483000;
  width: 360px;
  max-width: calc(100vw - 32px);
  box-sizing: border-box;
  padding: 12px 34px 12px 14px;
  border-radius: 12px;
  background: #181818;
  border: 1px solid rgba(30, 215, 96, 0.5);
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.55);
  color: #fff;
  font: 400 13px/1.45 "CircularSp", "Circular", "Helvetica Neue", Arial, sans-serif;
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
  background: #1ed760; box-shadow: 0 0 8px #1ed760;
}
#${ID} .ss-title b { color: #1ed760; font-weight: 700; }
#${ID} .ss-brand { font-size: 10.5px; font-weight: 600; letter-spacing: 0.08em; color: #a7a7a7; align-self: center; }
#${ID} p { margin: 0; color: #d6d6d6; }
#${ID} .ss-actions { margin-top: 10px; display: flex; justify-content: space-between; align-items: center; }
#${ID} .ss-ok {
  border: 0; border-radius: 999px; padding: 6px 14px; cursor: pointer;
  background: #1ed760; color: #000; font: 700 12.5px/1 inherit;
}
#${ID} .ss-ok:hover { background: #3be477; }
#${ID} .ss-x {
  position: absolute; top: 6px; right: 6px; width: 24px; height: 24px;
  border: 0; border-radius: 6px; background: transparent; color: #a7a7a7;
  font-size: 18px; line-height: 1; cursor: pointer;
}
#${ID} .ss-x:hover { color: #fff; background: rgba(255,255,255,0.08); }
`

export async function showSpotifyNotice(): Promise<void> {
  if (document.getElementById(ID)) return
  try {
    const stored = await chrome.storage.local.get(SPOTIFY_NOTE_KEY)
    if (stored[SPOTIFY_NOTE_KEY] === true) return
  } catch {
    return
  }
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = CSS
    document.documentElement.appendChild(style)
  }
  const card = document.createElement('div')
  card.id = ID
  card.setAttribute('role', 'status')
  card.innerHTML = `
    <button type="button" class="ss-x" aria-label="Dismiss">×</button>
    <div class="ss-title"><span>Spotify ads are <b>muted</b> by default</span></div>
    <p>Spotify delivers ads in-stream, so Ad Sensei mutes this tab for exactly as long as each ad plays. Prefer them gone entirely? Turn on <b>Skip audio ads (beta)</b> in the Ad Sensei popup under Controls &rarr; Spotify — it rewrites the player to skip ads outright, with muting kept as the fallback.</p>
    <div class="ss-actions"><span class="ss-brand">AD SENSEI</span><button type="button" class="ss-ok">Got it</button></div>
  `
  const dismiss = () => {
    card.classList.remove('skip-sensei-visible')
    setTimeout(() => card.remove(), 250)
    void chrome.storage.local.set({ [SPOTIFY_NOTE_KEY]: true }).catch(() => {})
  }
  card.querySelector('.ss-x')!.addEventListener('click', dismiss)
  card.querySelector('.ss-ok')!.addEventListener('click', dismiss)
  ;(document.body ?? document.documentElement).appendChild(card)
  requestAnimationFrame(() => card.classList.add('skip-sensei-visible'))
}
