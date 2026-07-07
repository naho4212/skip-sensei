import {
  clearAnalysisCache,
  getSettings,
  setSiteAllowlisted,
  updateSettings,
} from '../storage'
import type { LlmProvider, Message, Settings } from '../types'

const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T

const providerEl = $<HTMLSelectElement>('provider')
const providerInfoEl = $('provider-info')
const cloudFieldsEl = $('cloud-fields')
const apiKeyEl = $<HTMLInputElement>('api-key')
const modelEl = $<HTMLInputElement>('model')
const thresholdEl = $<HTMLInputElement>('threshold')
const thresholdValueEl = $<HTMLOutputElement>('threshold-value')
const showToastEl = $<HTMLInputElement>('show-toast')
const builtinStatusEl = $('builtin-status')
const apiKeyLinkEl = $<HTMLAnchorElement>('api-key-link')
const savedNoteEl = $('saved-note')

let savedTimer: number | null = null
let currentSettings: Settings

/** Where to get a key, per cloud provider. */
const KEY_LINKS: Record<Exclude<LlmProvider, 'builtin'>, string> = {
  gemini: 'https://aistudio.google.com/apikey',
  anthropic: 'https://console.anthropic.com/settings/keys',
  openai: 'https://platform.openai.com/api-keys',
}

function flashSaved() {
  savedNoteEl.hidden = false
  if (savedTimer !== null) clearTimeout(savedTimer)
  savedTimer = window.setTimeout(() => (savedNoteEl.hidden = true), 1200)
}

const PROVIDER_INFO: Record<LlmProvider, string> = {
  builtin:
    'Analysis time: runs on your device — roughly 30–60 seconds per 20 minutes of video, so an hour-long podcast can take ~5 minutes on first watch. Each video is analyzed once, then cached; re-watches are instant. Free and fully private.',
  gemini:
    'Recommended free option. Fast and accurate, and its huge context analyzes even a 3-hour video in one pass — no chunking. Free tier needs no credit card (1,500 videos/day). Get a free key at aistudio.google.com/apikey. Each video is analyzed once, then cached.',
  anthropic:
    'Analysis time: a few seconds, regardless of video length. Uses your Anthropic API key (default model claude-haiku-4-5); typical cost is well under 1¢ per video. Each video is analyzed once, then cached.',
  openai:
    'Analysis time: a few seconds, regardless of video length. Uses your OpenAI API key (default model gpt-5-mini); typical cost is well under 1¢ per video. Each video is analyzed once, then cached.',
}

function render(settings: Settings) {
  currentSettings = settings
  const provider = settings.llmProvider
  providerEl.value = provider
  providerInfoEl.textContent = PROVIDER_INFO[provider]
  modelEl.value = settings.model
  thresholdEl.value = String(settings.confidenceThreshold)
  thresholdValueEl.value = settings.confidenceThreshold.toFixed(2)
  showToastEl.checked = settings.showSkipToast
  cloudFieldsEl.hidden = provider === 'builtin'
  builtinStatusEl.hidden = provider !== 'builtin'

  if (provider !== 'builtin') {
    apiKeyEl.value = settings.apiKeys[provider] ?? ''
    const link = KEY_LINKS[provider]
    apiKeyLinkEl.href = link
    apiKeyLinkEl.textContent =
      provider === 'gemini' ? 'Get a free key →' : 'Get a key →'
  }
}

async function save(patch: Partial<Settings>) {
  render(await updateSettings(patch))
  flashSaved()
}

async function renderBuiltinStatus() {
  const message: Message = { type: 'skipSensei:checkBuiltinAI' }
  try {
    const { availability }: { availability: string } =
      await chrome.runtime.sendMessage(message)
    const texts: Record<string, string> = {
      available: 'Built-in AI is ready on this device.',
      downloadable:
        'Built-in AI model will download on first use (one-time, ~2 GB).',
      downloading: 'Built-in AI model is downloading…',
      unavailable:
        '⚠ Built-in AI is not available in this browser — sponsor detection needs Chrome 138+ with on-device AI, or an API key.',
    }
    builtinStatusEl.textContent =
      texts[availability] ?? `Built-in AI status: ${availability}`
  } catch {
    builtinStatusEl.textContent = ''
  }
}

async function renderAllowlist() {
  const listEl = $<HTMLUListElement>('allowlist')
  const { allowlist } = await getSettings()
  if (allowlist.length === 0) {
    listEl.innerHTML = '<li class="allowlist-empty">No sites paused.</li>'
    return
  }
  listEl.replaceChildren(
    ...[...allowlist].sort().map((host) => {
      const li = document.createElement('li')
      const name = document.createElement('span')
      name.textContent = host
      const remove = document.createElement('button')
      remove.textContent = 'Remove'
      remove.addEventListener('click', async () => {
        await setSiteAllowlisted(host, false)
        await renderAllowlist()
      })
      li.append(name, remove)
      return li
    }),
  )
}

function debounce(fn: () => void, ms: number) {
  let timer: number | null = null
  return () => {
    if (timer !== null) clearTimeout(timer)
    timer = window.setTimeout(fn, ms)
  }
}

async function main() {
  render(await getSettings())
  void renderBuiltinStatus()

  providerEl.addEventListener('change', () =>
    save({ llmProvider: providerEl.value as LlmProvider }),
  )
  apiKeyEl.addEventListener(
    'input',
    debounce(() => {
      const provider = currentSettings.llmProvider
      if (provider === 'builtin') return
      void save({
        apiKeys: { ...currentSettings.apiKeys, [provider]: apiKeyEl.value },
      })
    }, 400),
  )
  modelEl.addEventListener(
    'input',
    debounce(() => void save({ model: modelEl.value }), 400),
  )
  thresholdEl.addEventListener('input', () => {
    thresholdValueEl.value = Number(thresholdEl.value).toFixed(2)
  })
  thresholdEl.addEventListener('change', () =>
    save({ confidenceThreshold: Number(thresholdEl.value) }),
  )
  showToastEl.addEventListener('change', () =>
    save({ showSkipToast: showToastEl.checked }),
  )

  const blockTrackersEl = $<HTMLInputElement>('block-trackers')
  blockTrackersEl.checked = (await getSettings()).blockTrackers
  blockTrackersEl.addEventListener('change', () =>
    save({ blockTrackers: blockTrackersEl.checked }),
  )

  const aiEnhancementsEl = $<HTMLInputElement>('ai-enhancements')
  aiEnhancementsEl.checked = (await getSettings()).aiEnhancements
  aiEnhancementsEl.addEventListener('change', () =>
    save({ aiEnhancements: aiEnhancementsEl.checked }),
  )

  await renderAllowlist()
  const allowlistInput = $<HTMLInputElement>('allowlist-input')
  const addSite = async () => {
    const raw = allowlistInput.value.trim().toLowerCase()
    // Accept a pasted URL or a bare hostname.
    let host = raw
    try {
      if (raw.includes('/')) host = new URL(raw.startsWith('http') ? raw : `https://${raw}`).hostname
    } catch {
      host = raw
    }
    host = host.replace(/^www\./, '')
    if (!host) return
    await setSiteAllowlisted(host, true)
    allowlistInput.value = ''
    await renderAllowlist()
  }
  $<HTMLButtonElement>('allowlist-add-btn').addEventListener('click', addSite)
  allowlistInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void addSite()
  })

  const clearCacheEl = $<HTMLButtonElement>('clear-cache')
  const clearResultEl = $('clear-cache-result')
  clearCacheEl.addEventListener('click', async () => {
    clearCacheEl.disabled = true
    const count = await clearAnalysisCache()
    clearResultEl.textContent = `Cleared ${count} cached ${count === 1 ? 'video' : 'videos'}.`
    clearCacheEl.disabled = false
  })
}

void main()
