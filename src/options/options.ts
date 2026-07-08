import {
  clearAnalysisCache,
  getApiUsage,
  getCacheStats,
  getSettings,
  resetApiUsage,
  setSiteAllowlisted,
  updateSettings,
} from '../storage'
import {
  FREE_TIER_DAILY_LIMIT,
  type KeyedProvider,
  type LlmProvider,
  type Message,
  type Settings,
} from '../types'

const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T

const providerEl = $<HTMLSelectElement>('provider')
const providerInfoEl = $('provider-info')
const cloudFieldsEl = $('cloud-fields')
const apiKeyEl = $<HTMLInputElement>('api-key')
const modelSelectEl = $<HTMLSelectElement>('model-select')
const modelEl = $<HTMLInputElement>('model')
const thresholdEl = $<HTMLInputElement>('threshold')
const thresholdValueEl = $<HTMLOutputElement>('threshold-value')
const showToastEl = $<HTMLInputElement>('show-toast')
const builtinStatusEl = $('builtin-status')
const apiKeyLinkEl = $<HTMLAnchorElement>('api-key-link')
const savedNoteEl = $('saved-note')

let savedTimer: number | null = null
let currentSettings: Settings

/** Where to get a key, per keyed cloud provider. */
const KEY_LINKS: Record<KeyedProvider, string> = {
  gemini: 'https://aistudio.google.com/apikey',
  groq: 'https://console.groq.com/keys',
  openrouter: 'https://openrouter.ai/settings/keys',
  anthropic: 'https://console.anthropic.com/settings/keys',
  openai: 'https://platform.openai.com/api-keys',
  openclaw: 'https://docs.openclaw.ai/gateway/openai-http-api',
}

/** Providers whose free tier makes the key link say so. */
const FREE_KEY_PROVIDERS = new Set<LlmProvider>(['gemini', 'groq', 'openrouter'])

/** Sentinel select value that reveals the free-text model field. */
const CUSTOM_MODEL = '__custom__'

/** Selectable models per provider ('' = provider default). Testing aid — the
 * "Custom…" choice still accepts any model id. */
const MODEL_OPTIONS: Record<
  Exclude<LlmProvider, 'builtin'>,
  { value: string; label: string }[]
> = {
  groq: [
    { value: '', label: 'Provider default — llama-3.3-70b-versatile' },
    {
      value: 'llama-3.1-8b-instant',
      label: 'llama-3.1-8b-instant · fastest, 14.4K free req/day',
    },
    { value: 'llama-3.3-70b-versatile', label: 'llama-3.3-70b-versatile' },
    {
      value: 'meta-llama/llama-4-scout-17b-16e-instruct',
      label: 'llama-4-scout · highest free tokens/min',
    },
  ],
  openrouter: [
    {
      value: '',
      label: 'Provider default — llama-3.3-70b-instruct:free',
    },
    {
      value: 'meta-llama/llama-3.3-70b-instruct:free',
      label: 'meta-llama/llama-3.3-70b-instruct:free',
    },
    { value: 'deepseek/deepseek-r1:free', label: 'deepseek/deepseek-r1:free · slow, thorough' },
    { value: 'google/gemma-3-27b-it:free', label: 'google/gemma-3-27b-it:free' },
  ],
  ollama: [
    { value: '', label: 'Provider default — llama3.1:8b' },
    { value: 'llama3.1:8b', label: 'llama3.1:8b' },
    { value: 'qwen3:8b', label: 'qwen3:8b' },
    { value: 'deepseek-r1:8b', label: 'deepseek-r1:8b · slow, thorough' },
    { value: 'gemma3:12b', label: 'gemma3:12b · needs 16 GB+ RAM' },
  ],
  openclaw: [
    { value: '', label: 'Default OpenClaw agent' },
    { value: 'openclaw/default', label: 'openclaw/default (stable alias)' },
    // "Custom…" covers openclaw/<agentId> for a specific agent.
  ],
  gemini: [
    { value: '', label: 'Provider default — gemini-2.5-flash' },
    {
      value: 'gemini-2.5-flash-lite',
      label: 'gemini-2.5-flash-lite · fastest, biggest free quota',
    },
    { value: 'gemini-2.5-flash', label: 'gemini-2.5-flash' },
    {
      value: 'gemini-2.5-pro',
      label: 'gemini-2.5-pro · smartest, tiny free quota',
    },
    {
      value: 'gemini-flash-latest',
      label: 'gemini-flash-latest · auto-updates',
    },
    {
      value: 'gemini-flash-lite-latest',
      label: 'gemini-flash-lite-latest · auto-updates',
    },
  ],
  anthropic: [
    { value: '', label: 'Provider default — claude-haiku-4-5' },
    { value: 'claude-haiku-4-5', label: 'claude-haiku-4-5 · fast, cheap' },
    { value: 'claude-sonnet-4-5', label: 'claude-sonnet-4-5' },
    { value: 'claude-sonnet-5', label: 'claude-sonnet-5' },
    { value: 'claude-opus-4-8', label: 'claude-opus-4-8 · most capable' },
  ],
  openai: [
    { value: '', label: 'Provider default — gpt-5-mini' },
    { value: 'gpt-5-nano', label: 'gpt-5-nano · fastest, cheapest' },
    { value: 'gpt-5-mini', label: 'gpt-5-mini' },
    { value: 'gpt-5', label: 'gpt-5' },
    { value: 'gpt-5.1', label: 'gpt-5.1' },
  ],
}

/** Rebuild the model dropdown for the active provider and reflect settings. */
function renderModelPicker(provider: LlmProvider, model: string) {
  if (provider === 'builtin') return
  const options = [
    ...MODEL_OPTIONS[provider],
    { value: CUSTOM_MODEL, label: 'Custom…' },
  ]
  modelSelectEl.replaceChildren(
    ...options.map(({ value, label }) => {
      const option = document.createElement('option')
      option.value = value
      option.textContent = label
      return option
    }),
  )
  // Don't yank the custom field away mid-typing (e.g. "gpt-5" on the way to
  // "gpt-5.2" matches a listed model when the debounced save fires).
  const editing = document.activeElement === modelEl
  const isListed =
    !editing &&
    (model === '' || MODEL_OPTIONS[provider].some((o) => o.value === model))
  modelSelectEl.value = isListed ? model : CUSTOM_MODEL
  modelEl.hidden = isListed
  modelEl.value = isListed ? '' : model
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
    'Recommended free option. Fast and accurate, and its huge context analyzes even a 3-hour video in one pass — no chunking. Free tier needs no credit card (~250 videos/day, ~5 requests/min — Ad Sensei paces its calls and falls back to on-device AI if the limit is hit). Get a free key at aistudio.google.com/apikey. Each video is analyzed once, then cached. Tip: also add a Groq key — quick AI helper tasks then use Groq and never touch Gemini’s rate limit.',
  groq:
    'Free and very fast (Llama 3.3 70B). Free tier is generous on requests but tight on tokens/minute, so long videos are analyzed in paced chunks — a bit slower than Gemini on podcasts. Bonus: with a Groq key saved, quick AI helper tasks (popup review, cookie consent, selector repair) use Groq even when another provider is selected.',
  openrouter:
    'One free key, many open models (default Llama 3.3 70B :free). Free tier is 50 requests/day (1,000/day forever after a one-time $10 top-up) — fine for light use or as a backup. Each video is analyzed once, then cached.',
  ollama:
    'Fully local and unlimited — no key, no cloud, total privacy, and smarter than Chrome’s built-in AI. Needs the Ollama app running with a model pulled (e.g. “ollama pull llama3.1:8b”) and extension access enabled: OLLAMA_ORIGINS=chrome-extension://* . Analysis speed depends on your Mac.',
  openclaw:
    'Already running OpenClaw? Point Ad Sensei at its gateway and sponsor analysis uses whatever model your OpenClaw routes to — no extra key to manage. Enable the endpoint in your config (gateway.http.endpoints.chatCompletions.enabled: true) and paste your gateway token. Analysis runs as full agent turns, so it’s slower and heavier than a direct API. For safety, only video transcripts are ever sent to OpenClaw — the AI page helpers (popup review, cookie consent) stay on other providers, since the gateway token carries operator permissions.',
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
  renderModelPicker(provider, settings.model)
  thresholdEl.value = String(settings.confidenceThreshold)
  thresholdValueEl.value = settings.confidenceThreshold.toFixed(2)
  showToastEl.checked = settings.showSkipToast
  cloudFieldsEl.hidden = provider === 'builtin'
  builtinStatusEl.hidden = provider !== 'builtin'

  if (provider !== 'builtin') {
    const keyField = $('api-key-field')
    keyField.hidden = provider === 'ollama' // local server, no key
    $('openclaw-url-field').hidden = provider !== 'openclaw'
    const urlEl = $<HTMLInputElement>('openclaw-url')
    if (provider === 'openclaw' && document.activeElement !== urlEl) {
      urlEl.value = settings.openclawUrl
    }
    if (provider !== 'ollama') {
      apiKeyEl.value = settings.apiKeys[provider] ?? ''
      apiKeyLinkEl.href = KEY_LINKS[provider]
      $('api-key-label').textContent =
        provider === 'openclaw' ? 'Gateway token' : 'API key'
      apiKeyLinkEl.textContent =
        provider === 'openclaw'
          ? 'Setup guide →'
          : FREE_KEY_PROVIDERS.has(provider)
            ? 'Get a free key →'
            : 'Get a key →'
    }
  }
  void renderUsage(provider)
}

const fmt = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1000
      ? `${(n / 1000).toFixed(1)}K`
      : String(n)

const fmtBytes = (n: number) =>
  n >= 1_048_576
    ? `${(n / 1_048_576).toFixed(1)} MB`
    : n >= 1024
      ? `${(n / 1024).toFixed(1)} KB`
      : `${n} B`

async function renderCacheStats() {
  const el = $('cache-stats')
  const { entries, cacheBytes, totalBytes } = await getCacheStats()
  el.innerHTML =
    `<b>${entries.length}</b> ${entries.length === 1 ? 'video' : 'videos'} cached · ` +
    `<b>${fmtBytes(cacheBytes)}</b> <span class="dim">(all extension storage: ${fmtBytes(totalBytes)})</span>`
}

async function renderUsage(provider: LlmProvider) {
  const box = $('usage-box')
  if (provider === 'builtin') {
    box.hidden = true
    return
  }
  box.hidden = false
  const usage = await getApiUsage()
  const m = usage.monthly[provider]
  const requests = m?.requests ?? 0
  const tokens = (m?.inputTokens ?? 0) + (m?.outputTokens ?? 0)
  $('usage-monthly').innerHTML = `This month: <b>${requests}</b> ${requests === 1 ? 'request' : 'requests'} · <b>${fmt(tokens)}</b> tokens`

  const limit = FREE_TIER_DAILY_LIMIT[provider]
  const dailyEl = $('usage-daily')
  const noteEl = $('usage-note')
  if (limit) {
    const used = usage.dailyRequests[provider] ?? 0
    const pct = Math.min(100, Math.round((used / limit) * 100))
    dailyEl.innerHTML = `Today: <b>~${used} / ${limit}</b> free requests (~${pct}%)`
    noteEl.textContent =
      'Daily figure is an estimate of this extension’s own calls; resets ~midnight Pacific. Most videos/sites are cached, so usage stays low.'
    dailyEl.hidden = false
  } else {
    dailyEl.hidden = true
    noteEl.textContent =
      provider === 'ollama'
        ? 'Counts this extension’s calls to your local Ollama server — free and unlimited.'
        : provider === 'openclaw'
          ? 'Counts this extension’s calls to your OpenClaw gateway — cost depends on the model OpenClaw routes to.'
          : 'Counts this extension’s calls to your key. Most videos/sites are cached, so usage stays low.'
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

  // Clicking an ⓘ shouldn't toggle the checkbox it sits inside — hover only.
  document.querySelectorAll('.info').forEach((el) =>
    el.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
    }),
  )

  providerEl.addEventListener('change', () =>
    save({ llmProvider: providerEl.value as LlmProvider }),
  )
  apiKeyEl.addEventListener(
    'input',
    debounce(() => {
      const provider = currentSettings.llmProvider
      if (provider === 'builtin' || provider === 'ollama') return
      void save({
        apiKeys: { ...currentSettings.apiKeys, [provider]: apiKeyEl.value },
      })
    }, 400),
  )
  modelSelectEl.addEventListener('change', () => {
    if (modelSelectEl.value === CUSTOM_MODEL) {
      // Reveal the free-text field; nothing saved until an id is typed.
      modelEl.hidden = false
      modelEl.focus()
      return
    }
    modelEl.hidden = true
    void save({ model: modelSelectEl.value })
  })
  modelEl.addEventListener(
    'input',
    debounce(() => void save({ model: modelEl.value.trim() }), 400),
  )
  $<HTMLInputElement>('openclaw-url').addEventListener(
    'input',
    debounce(() => {
      const value = $<HTMLInputElement>('openclaw-url').value.trim()
      void save({
        openclawUrl:
          value || 'http://127.0.0.1:18789/v1/chat/completions',
      })
    }, 400),
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

  $<HTMLButtonElement>('usage-reset').addEventListener('click', async () => {
    await resetApiUsage()
    void renderUsage(currentSettings.llmProvider)
  })

  const extraLists: [string, keyof Settings][] = [
    ['block-trackers', 'blockTrackers'],
    ['block-cookie-notices', 'blockCookieNotices'],
    ['block-social', 'blockSocial'],
    ['block-popups', 'blockPopups'],
    ['telemetry', 'telemetryEnabled'],
  ]
  const loaded = await getSettings()
  for (const [elId, key] of extraLists) {
    const el = $<HTMLInputElement>(elId)
    el.checked = loaded[key] as boolean
    el.addEventListener('change', () => save({ [key]: el.checked }))
  }

  const aiEnhancementsEl = $<HTMLInputElement>('ai-enhancements')
  aiEnhancementsEl.checked = (await getSettings()).aiEnhancements
  aiEnhancementsEl.addEventListener('change', () =>
    save({ aiEnhancements: aiEnhancementsEl.checked }),
  )

  const debugLoggingEl = $<HTMLInputElement>('debug-logging')
  debugLoggingEl.checked = (await getSettings()).debugLogging
  debugLoggingEl.addEventListener('change', () =>
    save({ debugLogging: debugLoggingEl.checked }),
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

  void renderCacheStats()
  $<HTMLButtonElement>('cache-refresh').addEventListener('click', () =>
    void renderCacheStats(),
  )
  $<HTMLAnchorElement>('open-log').href = chrome.runtime.getURL(
    'src/log/index.html',
  )

  // Prefill the support email with version context (mailto = no backend, no
  // spam surface; swap for an embedded form once an email API is wired up).
  const { version } = chrome.runtime.getManifest()
  $<HTMLAnchorElement>('contact-link').href =
    `mailto:info@singlefinmedia.com?subject=${encodeURIComponent(`Ad Sensei v${version} — feedback`)}`

  const clearCacheEl = $<HTMLButtonElement>('clear-cache')
  const clearResultEl = $('clear-cache-result')
  clearCacheEl.addEventListener('click', async () => {
    clearCacheEl.disabled = true
    const count = await clearAnalysisCache()
    clearResultEl.textContent = `Cleared ${count} cached ${count === 1 ? 'video' : 'videos'}.`
    clearCacheEl.disabled = false
    void renderCacheStats()
  })
}

void main()
