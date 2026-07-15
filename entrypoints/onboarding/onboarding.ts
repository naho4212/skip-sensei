import {
  getSettings,
  setKeyReminder,
  updateSettings,
} from '../../src/storage'
import type { Settings } from '../../src/types'

document.getElementById('open-options')?.addEventListener('click', () => {
  void chrome.runtime.openOptionsPage()
})

// ---- Blocking levels ---------------------------------------------------
// One decision instead of five toggles. Each level is a plain settings
// patch, so the popup/options can still adjust everything piecemeal later —
// the cards just re-derive the closest level from settings on load. Medium/
// High request the all-sites grant on the click gesture; declining still
// enables the network (DNR) side of the picks, and the hint says so.
const LEVELS: Record<'low' | 'medium' | 'high', Partial<Settings>> = {
  low: {
    blockAllAds: false,
    blockCookieNotices: false,
    blockPopups: false,
    blockSocial: false,
    aggressivePruning: false,
  },
  medium: {
    blockAllAds: true,
    blockCookieNotices: true,
    blockPopups: true,
    blockSocial: false,
    aggressivePruning: false,
  },
  high: {
    blockAllAds: true,
    blockCookieNotices: true,
    blockPopups: true,
    blockSocial: true,
    aggressivePruning: true,
  },
}
type Level = keyof typeof LEVELS

const DEFAULT_LEVEL_HINT_LINK = document.getElementById('diy-link')
const levelHint = document.getElementById('level-hint')
const levelCards = [
  ...document.querySelectorAll<HTMLButtonElement>('.level-card'),
]

function levelFromSettings(settings: Settings): Level {
  if (settings.blockAllAds && settings.blockSocial && settings.aggressivePruning)
    return 'high'
  if (settings.blockAllAds) return 'medium'
  return 'low'
}

function renderLevel(selected: Level) {
  for (const card of levelCards)
    card.classList.toggle('selected', card.dataset.level === selected)
}

void getSettings().then((settings) => renderLevel(levelFromSettings(settings)))

const hasBroadGrant = () =>
  chrome.permissions.contains({ origins: ['*://*/*'] }).catch(() => false)

for (const card of levelCards) {
  card.addEventListener('click', async () => {
    const level = card.dataset.level as Level
    let declined = false
    if (level !== 'low') {
      // contains() first: skip the dialog when access already exists (e.g.
      // revisiting this page after granting from the popup).
      const granted =
        (await hasBroadGrant()) ||
        (await chrome.permissions
          .request({ origins: ['*://*/*'] })
          .catch(() => false))
      declined = !granted
    }
    await updateSettings(LEVELS[level])
    renderLevel(level)
    if (levelHint && declined) {
      levelHint.textContent =
        'All-sites access was declined — request-level blocking is on, but hiding leftover frames on pages needs the grant. Pick the level again to retry, or grant it later from the popup.'
    }
  })
}

DEFAULT_LEVEL_HINT_LINK?.addEventListener('click', (e) => {
  e.preventDefault()
  void chrome.runtime.openOptionsPage()
})

// ---- Optional AI keys (the recommended free pair, or a reminder) ------
// Gemini becomes the main provider (transcript analysis). Groq is saved as a
// key ONLY — resolveHelperProvider() routes the bursty helper calls (popup
// review, consent clicks, selector repair) to it automatically whenever the
// key exists, keeping Gemini's 5 RPM free tier for transcripts.
const keyHint = document.getElementById('key-hint')

function wireKeyRow(opts: {
  rowId: string
  inputId: string
  saveId: string
  savedId: string
  origin: string
  save: (key: string) => Promise<void>
}) {
  const row = document.getElementById(opts.rowId)
  const input = document.getElementById(opts.inputId) as HTMLInputElement | null
  const savedLine = document.getElementById(opts.savedId)
  const markSaved = () => {
    if (row) row.hidden = true
    if (savedLine) savedLine.hidden = false
    // Both keys in? Nothing left to be reminded about.
    if (
      document.getElementById('key-row')?.hidden &&
      document.getElementById('groq-row')?.hidden
    )
      document.getElementById('key-later')?.setAttribute('hidden', '')
  }
  document.getElementById(opts.saveId)?.addEventListener('click', async () => {
    const key = input?.value.trim()
    if (!key) {
      input?.focus()
      return
    }
    // Host grant on this click gesture; declining just means the fetch fails
    // later and analysis falls back to on-device AI.
    await chrome.permissions
      .request({ origins: [opts.origin] })
      .catch(() => false)
    await opts.save(key)
    await setKeyReminder(false)
    markSaved()
  })
  return { markSaved }
}

const geminiRow = wireKeyRow({
  rowId: 'key-row',
  inputId: 'gemini-key',
  saveId: 'save-key',
  savedId: 'gemini-saved',
  origin: 'https://generativelanguage.googleapis.com/*',
  save: async (key) => {
    const settings = await getSettings()
    await updateSettings({
      llmProvider: 'gemini',
      apiKeys: { ...settings.apiKeys, gemini: key },
    })
  },
})

const groqRow = wireKeyRow({
  rowId: 'groq-row',
  inputId: 'groq-key',
  saveId: 'save-groq',
  savedId: 'groq-saved',
  origin: 'https://api.groq.com/*',
  save: async (key) => {
    // Key only — deliberately NOT the main provider; the helper router picks
    // it up on its own.
    const settings = await getSettings()
    await updateSettings({ apiKeys: { ...settings.apiKeys, groq: key } })
  },
})

void getSettings().then((settings) => {
  if (settings.apiKeys.gemini) geminiRow.markSaved()
  if (settings.apiKeys.groq) groqRow.markSaved()
})

document.getElementById('key-later')?.addEventListener('click', async () => {
  await setKeyReminder(true)
  document.getElementById('key-row')?.setAttribute('hidden', '')
  document.getElementById('groq-row')?.setAttribute('hidden', '')
  if (keyHint)
    keyHint.textContent =
      'No problem — a reminder will wait in the toolbar popup.'
})

// Aggressive-mode opt-in (no extra permission): the service worker registers
// the MAIN-world pruner the moment the setting flips.
const aggressiveBox = document.getElementById(
  'aggressive-optin',
) as HTMLInputElement | null
if (aggressiveBox) {
  void getSettings().then((settings) => {
    aggressiveBox.checked = settings.aggressivePruning
  })
  aggressiveBox.addEventListener('change', () => {
    void updateSettings({ aggressivePruning: aggressiveBox.checked })
  })
}

document.getElementById('close')?.addEventListener('click', () => {
  window.close()
})

// Crash-report disclosure toggle — mirrors the telemetryEnabled setting so the
// choice made here and the one in options stay in sync.
const telemetryBox = document.getElementById(
  'telemetry-optout',
) as HTMLInputElement | null
if (telemetryBox) {
  void getSettings().then((settings) => {
    telemetryBox.checked = settings.telemetryEnabled
  })
  telemetryBox.addEventListener('change', () => {
    void updateSettings({ telemetryEnabled: telemetryBox.checked })
  })
}
