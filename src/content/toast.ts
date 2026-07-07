import { PLAYER } from '../selectors'

/**
 * Minimal in-player toast shown when a sponsor segment is skipped, with an
 * "Unskip" control that feeds correction data. All classes are
 * skip-sensei-prefixed.
 */

const STYLE_ID = 'skip-sensei-toast-style'
const TOAST_CLASS = 'skip-sensei-toast'
const HIDE_AFTER_MS = 5000

const CSS = `
.${TOAST_CLASS} {
  position: absolute;
  left: 12px;
  bottom: 64px;
  z-index: 60;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-radius: 8px;
  background: rgba(20, 20, 20, 0.92);
  color: #fff;
  font: 500 13px/1.3 "Roboto", "Arial", sans-serif;
  opacity: 0;
  transform: translateY(6px);
  transition: opacity 0.2s, transform 0.2s;
  pointer-events: auto;
}
.${TOAST_CLASS}.skip-sensei-visible {
  opacity: 1;
  transform: translateY(0);
}
.${TOAST_CLASS} button {
  border: 1px solid rgba(255, 255, 255, 0.35);
  border-radius: 6px;
  background: transparent;
  color: #fff;
  font: inherit;
  padding: 3px 10px;
  cursor: pointer;
}
.${TOAST_CLASS} button:hover {
  background: rgba(255, 255, 255, 0.15);
}
`

let hideTimer: number | null = null

export function showSkipToast(seconds: number, onUnskip: () => void) {
  const player = document.querySelector<HTMLElement>(PLAYER)
  if (!player) return

  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = CSS
    document.head.appendChild(style)
  }

  removeToast()
  const toast = document.createElement('div')
  toast.className = TOAST_CLASS
  const label = document.createElement('span')
  label.textContent = `Skipped sponsor (${Math.round(seconds)}s)`
  const button = document.createElement('button')
  button.textContent = 'Unskip'
  button.title = 'That was wrong — go back and don’t skip this again'
  button.addEventListener('click', () => {
    removeToast()
    onUnskip()
  })
  toast.append(label, button)
  player.appendChild(toast)
  requestAnimationFrame(() => toast.classList.add('skip-sensei-visible'))

  hideTimer = window.setTimeout(removeToast, HIDE_AFTER_MS)
}

export function removeToast() {
  if (hideTimer !== null) clearTimeout(hideTimer)
  hideTimer = null
  document.querySelectorAll(`.${TOAST_CLASS}`).forEach((el) => el.remove())
}
