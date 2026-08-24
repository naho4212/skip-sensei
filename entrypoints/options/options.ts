import {
  clearActivityLog,
  clearAdFeedback,
  clearAnalysisCache,
  clearSettingsLog,
  factoryReset,
  getActivityLog,
  getApiUsage,
  getCacheStats,
  getSettings,
  getSettingsLog,
  getSkipTimings,
  getStats,
  resetApiUsage,
  resetSettingsToDefaults,
  setSiteAllowlisted,
  updateSettings,
} from '../../src/storage'
import { FILTER_UPDATE_META_KEY } from '../../src/filter-updates'
import {
  type CatalogModel,
  supportsModelCatalog,
} from '../../src/model-catalog'
import {
  FREE_TIER_DAILY_LIMIT,
  type FilterUpdateStatus,
  type KeyedProvider,
  type LlmProvider,
  type Message,
  type ModelCatalogResult,
  type Settings,
} from '../../src/types'

const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T

const providerEl = $<HTMLSelectElement>('provider')
const providerInfoEl = $('provider-info')
const cloudFieldsEl = $('cloud-fields')
const apiKeyEl = $<HTMLInputElement>('api-key')
const modelSelectEl = $<HTMLSelectElement>('model-select')
const modelEl = $<HTMLInputElement>('model')
const modelRefreshEl = $<HTMLButtonElement>('model-refresh')
const modelRefreshStatusEl = $('model-refresh-status')
const fallbackFieldEl = $('fallback-field')
const fallbackEl = $<HTMLSelectElement>('fallback-provider')
const fallbackChainEl = $('fallback-chain')
const thresholdEl = $<HTMLInputElement>('threshold')
const thresholdValueEl = $<HTMLOutputElement>('threshold-value')
const showToastEl = $<HTMLInputElement>('show-toast')
const builtinStatusEl = $('builtin-status')
const apiKeyLinkEl = $<HTMLAnchorElement>('api-key-link')
const savedNoteEl = $('saved-note')

let savedTimer: number | null = null
let currentSettings: Settings

/** Live model lists fetched on demand (per provider), merged into the picker
 * below the curated aliases. Seeded from storage cache on load. */
const modelCatalogs: Partial<Record<LlmProvider, CatalogModel[]>> = {}

/** Human labels for the fallback dropdown + chain line. */
const PROVIDER_LABELS: Record<LlmProvider, string> = {
  builtin: 'On-device Chrome AI',
  gemini: 'Gemini',
  groq: 'Groq',
  openrouter: 'OpenRouter',
  ollama: 'Ollama',
  openclaw: 'OpenClaw',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
}

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

/** Optional host permission each provider's requests need (builtin needs none). */
const PROVIDER_ORIGINS: Partial<Record<LlmProvider, string>> = {
  gemini: 'https://generativelanguage.googleapis.com/*',
  anthropic: 'https://api.anthropic.com/*',
  openai: 'https://api.openai.com/*',
  groq: 'https://api.groq.com/*',
  openrouter: 'https://openrouter.ai/*',
  ollama: 'http://localhost/*',
  openclaw: 'http://127.0.0.1/*',
}

/**
 * Request the optional host permission a cloud/local-gateway provider needs.
 * Called from the provider-select change handler (a user gesture). If the user
 * declines, the service worker's fetch to that host simply fails and analysis
 * falls back to the on-device model — no worse than an unreachable provider.
 */
async function requestProviderHost(provider: LlmProvider): Promise<void> {
  const origin = PROVIDER_ORIGINS[provider]
  if (!origin) return
  try {
    if (await chrome.permissions.contains({ origins: [origin] })) return
    await chrome.permissions.request({ origins: [origin] })
  } catch {
    // request() throws outside a user gesture — harmless; the fetch will just
    // fall back to on-device AI if the permission never gets granted.
  }
}

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
  // Gemini publishes floating "-latest" aliases that always resolve to the
  // current model, so we list only those (plus Custom…) — no pinned version to
  // go stale and 404. The empty default resolves to gemini-flash-latest.
  gemini: [
    { value: '', label: 'Provider default — auto-updating (recommended)' },
    {
      value: 'gemini-flash-latest',
      label: 'gemini-flash-latest · newest fast model',
    },
    {
      value: 'gemini-flash-lite-latest',
      label: 'gemini-flash-lite-latest · fastest, biggest free quota',
    },
    {
      value: 'gemini-pro-latest',
      label: 'gemini-pro-latest · smartest, tiny free quota',
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

/** Rebuild the model dropdown for the active provider and reflect settings.
 * Curated auto-updating aliases sit up top; any on-demand-fetched catalog
 * models the aliases don't already cover are appended below them. */
function renderModelPicker(provider: LlmProvider, model: string) {
  if (provider === 'builtin') return
  const curated = MODEL_OPTIONS[provider]
  const curatedValues = new Set(curated.map((o) => o.value))
  const fetched = (modelCatalogs[provider] ?? []).filter(
    (m) => !curatedValues.has(m.id),
  )
  const options = [
    ...curated,
    ...fetched.map((m) => ({ value: m.id, label: m.label })),
    { value: CUSTOM_MODEL, label: 'Custom…' },
  ]
  const listedValues = new Set(options.map((o) => o.value))
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
  const isListed = !editing && (model === '' || listedValues.has(model))
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

/** Providers whose "active" state is a saved API key / gateway token. */
const KEYED_PROVIDERS: LlmProvider[] = [
  'gemini',
  'groq',
  'openrouter',
  'openai',
  'anthropic',
  'openclaw',
]

/** Tag each primary-provider option with a "key saved" marker so the dropdown
 * shows at a glance which providers are configured. Options are static in the
 * HTML, so the original label is stashed in a data attribute to re-decorate
 * idempotently (no marker accumulation across renders). */
function decorateProviderOptions(settings: Settings) {
  for (const opt of providerEl.options) {
    if (opt.dataset.base === undefined) opt.dataset.base = opt.textContent ?? ''
    const p = opt.value as LlmProvider
    const hasKey =
      KEYED_PROVIDERS.includes(p) &&
      !!settings.apiKeys[p as KeyedProvider]?.trim()
    opt.textContent = hasKey ? `${opt.dataset.base}  🟢 key saved` : opt.dataset.base
  }
}

function render(settings: Settings) {
  currentSettings = settings
  const provider = settings.llmProvider
  providerEl.value = provider
  decorateProviderOptions(settings)
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
      // Same mid-typing guard as the model/openclaw-url fields: the debounced
      // save re-renders, and overwriting the field while it has focus dropped
      // whatever was typed after the debounce fired.
      if (document.activeElement !== apiKeyEl) {
        apiKeyEl.value = settings.apiKeys[provider] ?? ''
      }
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
    // Model-list refresh is only meaningful for providers with a catalog.
    modelRefreshEl.hidden = !supportsModelCatalog(provider)
  }
  // Always run (self-hides for a built-in primary) so its own hidden state
  // stays correct rather than relying on the cloud-fields parent.
  renderFallback(settings)
  void renderUsage(provider)
  void renderRulesets()
}

/** Providers eligible as a fallback: cloud providers you've saved a key for,
 * minus the current primary. On-device is always the implicit final tier and is
 * offered separately as "On-device Chrome AI only". Local providers
 * (Ollama/OpenClaw) are intentionally NOT auto-listed — there's no saved-key
 * signal that they're set up, so showing them would offer a fallback that just
 * fails to a connection error; use them by selecting them as the primary. */
function fallbackCandidates(settings: Settings): LlmProvider[] {
  const primary = settings.llmProvider
  const keyed: KeyedProvider[] = [
    'gemini',
    'groq',
    'openrouter',
    'openai',
    'anthropic',
  ]
  return keyed.filter((p) => p !== primary && settings.apiKeys[p]?.trim())
}

/** Rebuild the "If primary is unavailable" picker + the chain preview line. */
function renderFallback(settings: Settings) {
  const primary = settings.llmProvider
  // No fallback picker when the primary is already on-device.
  fallbackFieldEl.hidden = primary === 'builtin'
  fallbackChainEl.hidden = primary === 'builtin'
  if (primary === 'builtin') return

  const candidates = fallbackCandidates(settings)
  const options: { value: LlmProvider; label: string }[] = [
    { value: 'builtin', label: 'On-device Chrome AI only' },
    ...candidates.map((p) => ({ value: p, label: PROVIDER_LABELS[p] })),
  ]
  fallbackEl.replaceChildren(
    ...options.map(({ value, label }) => {
      const opt = document.createElement('option')
      opt.value = value
      opt.textContent = label
      return opt
    }),
  )
  // A previously-saved fallback that's no longer offerable (its key was removed,
  // or it was a local provider we no longer auto-list) is reset to on-device so
  // the stored value can't diverge from what the chain will actually do.
  const saved = settings.fallbackProvider
  const valid = options.some((o) => o.value === saved)
  if (!valid && saved !== 'builtin') void save({ fallbackProvider: 'builtin' })
  fallbackEl.value = valid ? saved : 'builtin'

  const mid = valid && saved !== 'builtin' ? ` → ${PROVIDER_LABELS[saved]}` : ''
  fallbackChainEl.textContent = `Chain: ${PROVIDER_LABELS[primary]}${mid} → On-device Chrome AI`
}

const MODEL_CATALOG_PREFIX = 'skipSensei.modelCatalog.'

/** Seed the in-memory catalogs from storage so a prior refresh survives a
 * reopen of the options page. */
async function loadCachedCatalogs() {
  const all = await chrome.storage.local.get(null)
  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith(MODEL_CATALOG_PREFIX)) continue
    const result = value as ModelCatalogResult
    if (result?.models?.length) modelCatalogs[result.provider] = result.models
  }
}

/** On-demand "Refresh list": fetch the provider's live models, merge into the
 * picker, and report the outcome. Fails soft — keeps the current list on error. */
async function refreshModels() {
  const provider = currentSettings.llmProvider
  if (!supportsModelCatalog(provider)) return
  modelRefreshEl.disabled = true
  modelRefreshStatusEl.hidden = false
  modelRefreshStatusEl.textContent = 'Refreshing model list…'
  try {
    const result = (await chrome.runtime.sendMessage({
      type: 'skipSensei:refreshModels',
      provider,
    })) as ModelCatalogResult
    if (result.error) {
      modelRefreshStatusEl.textContent = `Couldn't refresh: ${result.error}. Using the built-in list.`
      return
    }
    modelCatalogs[provider] = result.models
    // Re-render against the freshest saved model so the selection is preserved.
    renderModelPicker(provider, currentSettings.model)
    modelRefreshStatusEl.textContent = result.models.length
      ? `Updated — ${result.models.length} models available.`
      : 'No additional models found; using the built-in list.'
  } catch {
    modelRefreshStatusEl.textContent = 'Refresh failed (is the provider reachable?). Using the built-in list.'
  } finally {
    modelRefreshEl.disabled = false
  }
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

// --- Analytics panel --------------------------------------------------------

async function renderAnalytics() {
  const stats = await getStats()
  const yt =
    stats.allTimeAdSkips + stats.allTimeSponsorSkips + stats.allTimeYtAdsHidden
  $('stat-youtube').textContent = fmt(yt)
  $('stat-webads').textContent = fmt(stats.allTimeWebAdsBlocked)
  $('stat-trackers').textContent = fmt(stats.allTimeTrackersBlocked)
  $('stat-cookies').textContent = fmt(stats.allTimeCookiesBlocked)
  const today = stats.today
  $('stat-youtube-today').textContent = String(
    today.adSkips + today.sponsorSkips + today.ytAdsHidden,
  )
  $('stat-webads-today').textContent = String(today.webAdsBlocked)
  $('stat-trackers-today').textContent = String(today.trackersBlocked)
  $('stat-cookies-today').textContent = String(today.cookiesBlocked)
  $('stat-breakdown').textContent =
    `YouTube total breaks down into ${fmt(stats.allTimeAdSkips)} video ads skipped, ` +
    `${fmt(stats.allTimeSponsorSkips)} sponsor segments, and ` +
    `${fmt(stats.allTimeYtAdsHidden)} display ads hidden.`

  await renderSkipPerformance()
}

/**
 * Skip latency, aggregated. Percentiles rather than an average: skip time is
 * long-tailed (a handful of formats defeat the seek and have to be burned
 * through), so a mean hides exactly the cases the user notices.
 */
async function renderSkipPerformance() {
  const timings = await getSkipTimings()
  const empty = $('skip-perf-empty')
  const grid = $('skip-perf-grid')
  const methods = $('skip-perf-methods')
  if (timings.length === 0) {
    empty.hidden = false
    grid.hidden = true
    methods.textContent = ''
    return
  }
  empty.hidden = true
  grid.hidden = false

  const secs = timings.map((t) => t.s).sort((a, b) => a - b)
  const at = (p: number) => secs[Math.min(secs.length - 1, Math.floor((secs.length * p) / 100))]
  const s = (v: number) => `${v.toFixed(1)}s`
  $('skip-median').textContent = s(at(50))
  $('skip-p90').textContent = s(at(90))
  $('skip-max').textContent = s(secs[secs.length - 1])
  const slow = secs.filter((v) => v > 5).length
  $('skip-slow-share').textContent = `${Math.round((slow / secs.length) * 100)}%`
  $('skip-count').textContent = String(secs.length)

  // Per-method medians: a slow median under "skip button" means YouTube is
  // gating the button; slow "fast-forward" means seeks are being reset.
  const byMethod = new Map<string, number[]>()
  for (const t of timings) {
    const list = byMethod.get(t.m) ?? []
    list.push(t.s)
    byMethod.set(t.m, list)
  }
  methods.textContent = [...byMethod.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([method, list]) => {
      const sorted = [...list].sort((a, b) => a - b)
      return `${method}: ${sorted.length} skips, median ${s(sorted[Math.floor(sorted.length / 2)])}`
    })
    .join(' · ')
}

// --- Activity & logs panel (merged from the former standalone log page) -----

const fmtWhen = (epochMs: number) =>
  epochMs
    ? new Date(epochMs).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : '—'

/** Friendly names for settings keys shown in the history table. */
const SETTING_LABELS: Record<string, string> = {
  masterEnabled: 'Ad Sensei enabled',
  adEngineEnabled: 'YouTube ad skipping',
  sponsorEngineEnabled: 'Sponsor detection',
  blockAllAds: 'Block all ads',
  blockTrackers: 'Block trackers & analytics',
  blockCookieNotices: 'Handle cookie-consent notices',
  blockSocial: 'Block social-media widgets',
  blockPopups: 'Block popup & overlay ads',
  blockMalware: 'Block malware & phishing',
  blockUrlTracking: 'Strip tracking parameters',
  allowlist: 'Paused sites',
  confidenceThreshold: 'Confidence threshold',
  showSkipToast: 'Skip toast',
  aiEnhancements: 'AI enhancements',
  aggressivePruning: "Block YouTube's first-party video ads",
  resumePlayback: 'Resume videos where you left off',
  debugLogging: 'Debug logging',
  telemetryEnabled: 'Anonymous diagnostics & usage counts',
  localOnlyMode: 'Local-only mode',
  llmProvider: 'AI provider',
  model: 'Model override',
}

function cell(text: string, className?: string): HTMLTableCellElement {
  const td = document.createElement('td')
  td.textContent = text
  if (className) td.className = className
  return td
}

/** The three tables under Activity & logs, each its own sub-tab. */
const LOG_VIEWS = ['activity', 'settings', 'cache'] as const
type LogView = (typeof LOG_VIEWS)[number]

/** Rows shown before the reader asks for more. */
const LOG_PAGE = 20

/** Newest-first rows per view, and how many of them are currently painted. */
const logRows: Record<LogView, HTMLTableRowElement[]> = {
  activity: [],
  settings: [],
  cache: [],
}
const logShown: Record<LogView, number> = {
  activity: LOG_PAGE,
  settings: LOG_PAGE,
  cache: LOG_PAGE,
}

/** Paint the first `logShown[view]` rows and update the footer + tab count. */
function paintLogView(view: LogView) {
  const rows = logRows[view]
  const total = rows.length
  const shown = Math.min(logShown[view], total)

  $(`${view}-empty`).hidden = total > 0
  // Hide the framed scroll box entirely when empty, not just the table —
  // an empty bordered rectangle reads as a broken table.
  const wrap = $(`${view}-table`).closest<HTMLElement>('.table-wrap')
  if (wrap) wrap.hidden = total === 0
  $<HTMLTableSectionElement>(`${view}-body`).replaceChildren(
    ...rows.slice(0, shown),
  )
  $(`count-${view}`).textContent = fmt(total)

  const footer = $(`more-${view}`)
  footer.hidden = total <= LOG_PAGE
  if (footer.hidden) return
  $(`shown-${view}`).textContent = `Showing ${fmt(shown)} of ${fmt(total)}`
  const moreBtn = $(`more-btn-${view}`)
  const remaining = total - shown
  moreBtn.hidden = remaining === 0
  moreBtn.textContent = `Show ${Math.min(LOG_PAGE, remaining)} more`
  // "Show all" only earns its space while it does something "show more" can't.
  $(`all-btn-${view}`).hidden = remaining <= LOG_PAGE
  $(`less-btn-${view}`).hidden = remaining > 0
}

async function renderActivity() {
  const entries = await getActivityLog()
  logRows.activity = [...entries].reverse().map((entry) => {
    const tr = document.createElement('tr')
    tr.append(
      cell(fmtWhen(entry.at), 'when'),
      cell(entry.feature),
      cell(entry.action),
      cell(entry.site ?? '—', 'site'),
    )
    return tr
  })
  paintLogView('activity')
}

async function renderSettingsHistory() {
  const log = await getSettingsLog()
  logRows.settings = [...log].reverse().map((entry) => {
    const tr = document.createElement('tr')
    tr.append(
      cell(fmtWhen(entry.at), 'when'),
      cell(SETTING_LABELS[entry.key] ?? entry.key),
    )
    const change = document.createElement('td')
    change.className = 'change'
    const from = document.createElement('span')
    from.className = 'from'
    from.textContent = entry.from
    const to = document.createElement('b')
    to.textContent = entry.to
    change.append(from, ' → ', to)
    tr.append(change)
    return tr
  })
  paintLogView('settings')
}

async function renderCacheTable() {
  const { entries, cacheBytes, totalBytes } = await getCacheStats()
  $('totals').innerHTML =
    `Analysis cache: <b>${fmtBytes(cacheBytes)}</b> across ` +
    `<b>${entries.length}</b> ${entries.length === 1 ? 'video' : 'videos'} · ` +
    `all extension storage: <b>${fmtBytes(totalBytes)}</b>`
  logRows.cache = entries.map((entry) => {
    const tr = document.createElement('tr')
    tr.append(cell(fmtWhen(entry.analyzedAt), 'when'))
    const video = document.createElement('td')
    const link = document.createElement('a')
    link.href = `https://www.youtube.com/watch?v=${entry.videoId}`
    link.target = '_blank'
    link.rel = 'noopener'
    link.textContent = entry.videoId
    video.append(link)
    tr.append(
      video,
      cell(entry.status),
      cell(String(entry.segments), 'num'),
      cell(entry.provider ?? '—'),
      cell(fmtBytes(entry.bytes), 'num'),
    )
    return tr
  })
  paintLogView('cache')
}

function showLogView(view: LogView) {
  for (const v of LOG_VIEWS) {
    const tab = $<HTMLButtonElement>(`subtab-${v}`)
    const active = v === view
    tab.classList.toggle('active', active)
    tab.setAttribute('aria-selected', String(active))
    tab.tabIndex = active ? 0 : -1
    $(`log-${v}`).hidden = !active
  }
}

function setupLogTabs() {
  const tabs = LOG_VIEWS.map((v) => $<HTMLButtonElement>(`subtab-${v}`))
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => showLogView(LOG_VIEWS[i]))
    // Arrow keys move between tabs, the way a tablist is expected to behave.
    tab.addEventListener('keydown', (e) => {
      const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
      if (!step) return
      e.preventDefault()
      const next = (i + step + tabs.length) % tabs.length
      showLogView(LOG_VIEWS[next])
      tabs[next].focus()
    })
  })

  for (const view of LOG_VIEWS) {
    $(`more-btn-${view}`).addEventListener('click', () => {
      logShown[view] += LOG_PAGE
      paintLogView(view)
    })
    $(`all-btn-${view}`).addEventListener('click', () => {
      logShown[view] = logRows[view].length
      paintLogView(view)
    })
    $(`less-btn-${view}`).addEventListener('click', () => {
      logShown[view] = LOG_PAGE
      paintLogView(view)
      $(`log-${view}`).scrollIntoView({ block: 'nearest' })
    })
  }
}

function renderLogs() {
  // A fresh read starts each table back at its first page.
  for (const v of LOG_VIEWS) logShown[v] = LOG_PAGE
  void renderActivity()
  void renderSettingsHistory()
  void renderCacheTable()
}

// --- Sidebar navigation -----------------------------------------------------

const PANELS = ['youtube', 'adblock', 'ai', 'analytics', 'logs', 'about']

function showPanel(name: string) {
  const panel = PANELS.includes(name) ? name : 'youtube'
  for (const p of PANELS) $(`panel-${p}`).hidden = p !== panel
  for (const btn of document.querySelectorAll<HTMLButtonElement>('.nav-item')) {
    const active = btn.dataset.panel === panel
    btn.classList.toggle('active', active)
    // The visual .active class is invisible to assistive tech.
    if (active) btn.setAttribute('aria-current', 'page')
    else btn.removeAttribute('aria-current')
  }
  // Render on demand — analytics/logs pull fresh data when first shown.
  if (panel === 'analytics') void renderAnalytics()
  if (panel === 'logs') renderLogs()
}

function setupNav() {
  for (const btn of document.querySelectorAll<HTMLButtonElement>('.nav-item')) {
    btn.addEventListener('click', () => {
      const panel = btn.dataset.panel!
      history.replaceState(null, '', `#${panel}`)
      showPanel(panel)
    })
  }
  // Back/forward (and hand-edited hashes) switch panels too — replaceState
  // alone wrote the hash but nothing ever read it after load.
  window.addEventListener('hashchange', () =>
    showPanel(location.hash.replace('#', '')),
  )
  showPanel(location.hash.replace('#', '') || 'youtube')
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

/** Fire-and-forget UI-usage counter bump, routed through the service worker
 * so its single storage chain serializes all writers. Counts use of Ad
 * Sensei's OWN controls only (setting names, never values). Rides the same
 * telemetry consent as diagnostics — the rollup send is gated on it. */
function usage(counter: string) {
  void chrome.runtime
    .sendMessage({ type: 'skipSensei:uiUsage', counter })
    .catch(() => {})
}

async function save(patch: Partial<Settings>) {
  for (const key of Object.keys(patch)) usage(`uiSet_${key}`)
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

// --- Filter rulesets panel -------------------------------------------------

/** Shape of the skipSensei:getRulesetInfo response (see net-blocker.ts). */
interface RulesetInfo {
  counts: Record<string, number>
  enabled: string[]
  availableTotal: number
  loadedTotal: number
}

interface RulesetGroup {
  label: string
  /** Backing boolean setting — the single source of truth syncNetBlocker reads. */
  setting: keyof Settings
  /** Constituent ruleset ids, shown as sub-rows with their own loaded state. */
  rulesets: string[]
  tip: string
  /** cookies/social/popups only take effect when Web ads (blockAllAds) is on. */
  gatedOnAds?: boolean
  /** url_tracking needs all-sites host access to rewrite URLs. */
  needsPermission?: boolean
}

/**
 * Upstream source per ruleset id, for attribution captions. All but malware
 * are AdGuard's prebuilt MV3 filters (@adguard/dnr-rulesets); ads_base is
 * AdGuard's EasyList-derived Base filter. Malware is URLhaus (abuse.ch).
 */
const RULESET_SOURCES: Record<string, string> = {
  ads_base: 'AdGuard Base · EasyList-based',
  ads_mobile: 'AdGuard Mobile Ads',
  trackers: 'AdGuard Tracking Protection',
  cookies: 'AdGuard Cookie Notices',
  social: 'AdGuard Social Media',
  popups: 'AdGuard Popups',
  url_tracking: 'AdGuard URL Tracking',
  malware: 'URLhaus · abuse.ch',
}

const RULESET_GROUPS: RulesetGroup[] = [
  {
    label: 'Web ads',
    setting: 'blockAllAds',
    rulesets: ['ads_base', 'ads_mobile'],
    tip: 'The core ad-blocking lists (AdGuard Base + Mobile Ads). Same switch as "Block all ads" in the popup.',
  },
  {
    label: 'Trackers & analytics',
    setting: 'blockTrackers',
    rulesets: ['trackers'],
    tip: 'Blocks tracking/analytics pixels (TikTok, Snapchat, Google Tag Manager, etc.) — the largest list.',
  },
  {
    label: 'Cookie-consent notices',
    setting: 'blockCookieNotices',
    rulesets: ['cookies'],
    gatedOnAds: true,
    tip: 'Hides "we value your privacy" banners. With AI enhancements on, also clicks Reject so your choice registers.',
  },
  {
    label: 'Social widgets & tracking',
    setting: 'blockSocial',
    rulesets: ['social'],
    gatedOnAds: true,
    tip: 'Blocks share buttons and embedded like/follow widgets that track you across sites.',
  },
  {
    label: 'Popup & overlay ads',
    setting: 'blockPopups',
    rulesets: ['popups'],
    gatedOnAds: true,
    tip: 'Blocks intrusive popup/overlay ads. With AI enhancements on, keeps useful overlays (logins, consent) and hides only annoyances.',
  },
  {
    label: 'URL tracking parameters',
    setting: 'blockUrlTracking',
    rulesets: ['url_tracking'],
    needsPermission: true,
    tip: 'Strips tracking params (utm_*, fbclid, gclid, and hundreds more) from links as you browse. Needs all-sites access to rewrite URLs.',
  },
  {
    label: 'Malware & phishing domains',
    setting: 'blockMalware',
    rulesets: ['malware'],
    tip: 'Blocks domains currently distributing malware (URLhaus / abuse.ch). Independent of ad blocking; on by default.',
  },
]

function infoIcon(tip: string): HTMLElement {
  const el = document.createElement('span')
  el.className = 'info'
  el.tabIndex = 0
  el.dataset.tip = tip
  // The CSS tooltip renders from data-tip, which screen readers never see.
  el.setAttribute('aria-label', tip)
  el.textContent = 'ⓘ'
  // These rows render after init, so the global .info click-guard hasn't bound
  // them — stop the click from toggling the checkbox this icon sits inside.
  el.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
  })
  return el
}

function buildRulesetGroup(
  group: RulesetGroup,
  info: RulesetInfo,
  enabled: Set<string>,
  settings: Settings,
  adsOn: boolean,
): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'ruleset-group'

  const gated = group.gatedOnAds && !adsOn
  const head = document.createElement('label')
  head.className = 'ruleset-head'

  const box = document.createElement('input')
  box.type = 'checkbox'
  box.checked = Boolean(settings[group.setting])
  box.addEventListener('change', () => void onRulesetToggle(group, box))

  const label = document.createElement('span')
  label.className = 'ruleset-label'
  label.textContent = group.label

  head.append(box, label, infoIcon(group.tip))
  if (gated) {
    const gate = document.createElement('span')
    gate.className = 'ruleset-gate'
    gate.textContent = '(needs Web ads on)'
    head.append(gate)
  }
  wrap.append(head)

  const sub = document.createElement('div')
  sub.className = 'ruleset-sub'
  for (const id of group.rulesets) {
    const row = document.createElement('div')
    row.className = 'ruleset-subrow'

    const dot = document.createElement('span')
    const isLoaded = enabled.has(id)
    dot.className = isLoaded ? 'ruleset-dot loaded' : 'ruleset-dot'

    const code = document.createElement('code')
    code.textContent = id

    const count = document.createElement('span')
    count.className = 'ruleset-count'
    const n = info.counts[id] ?? 0
    count.textContent = `${n.toLocaleString()} ${n === 1 ? 'rule' : 'rules'}`

    row.append(dot, code, count)
    const src = RULESET_SOURCES[id]
    if (src) {
      const source = document.createElement('span')
      source.className = 'ruleset-source'
      source.textContent = src
      row.append(source)
    }
    if (isLoaded) {
      const loaded = document.createElement('span')
      loaded.className = 'ruleset-loaded-label'
      loaded.textContent = 'loaded'
      row.append(loaded)
    }
    sub.append(row)
  }
  wrap.append(sub)
  return wrap
}

async function onRulesetToggle(group: RulesetGroup, box: HTMLInputElement) {
  // url_tracking needs all-sites access to actually rewrite URLs — request it
  // on the enabling gesture and revert the checkbox if the user declines.
  if (group.needsPermission && box.checked) {
    const granted = await chrome.permissions
      .request({ origins: ['*://*/*'] })
      .catch(() => false)
    if (!granted) {
      box.checked = false
      return
    }
  }
  await save({ [group.setting]: box.checked })
  // The enabled-ruleset state changes only after the service worker's sync
  // runs; re-read once it has settled so the loaded dots + total catch up.
  setTimeout(() => void renderRulesets(), 500)
}

async function renderRulesets() {
  let info: RulesetInfo | undefined
  try {
    info = await chrome.runtime.sendMessage({ type: 'skipSensei:getRulesetInfo' })
  } catch {
    return
  }
  if (!info) return

  const settings = currentSettings ?? (await getSettings())
  const enabled = new Set(info.enabled)
  const adsOn = settings.masterEnabled && settings.blockAllAds

  const total = $('ruleset-total')
  total.replaceChildren()
  const loaded = document.createElement('strong')
  loaded.textContent = info.loadedTotal.toLocaleString()
  total.append(
    loaded,
    document.createTextNode(
      ` of ${info.availableTotal.toLocaleString()} rules loaded`,
    ),
  )

  $('ruleset-list').replaceChildren(
    ...RULESET_GROUPS.map((g) =>
      buildRulesetGroup(g, info!, enabled, settings, adsOn),
    ),
  )
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
  usage('uiOptionsOpens')
  await loadCachedCatalogs()
  render(await getSettings())
  void renderBuiltinStatus()

  // Clicking an ⓘ shouldn't toggle the checkbox it sits inside — hover only.
  // Also mirror each data-tip into aria-label: the CSS tooltip is invisible
  // to screen readers, so focusing the icon should announce the tip text.
  document.querySelectorAll<HTMLElement>('.info').forEach((el) => {
    if (el.dataset.tip) el.setAttribute('aria-label', el.dataset.tip)
    el.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
    })
  })

  providerEl.addEventListener('change', () => {
    const provider = providerEl.value as LlmProvider
    // Cloud/local-gateway hosts are optional permissions — request the one this
    // provider needs while we still have the user gesture from the change event.
    void requestProviderHost(provider)
    void save({ llmProvider: provider })
  })
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
  modelRefreshEl.addEventListener('click', () => void refreshModels())
  fallbackEl.addEventListener('change', () => {
    void save({ fallbackProvider: fallbackEl.value as LlmProvider })
  })
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

  // Ruleset toggles (trackers/cookies/social/popups/malware/url_tracking + the
  // Web-ads master) live in the "Filter rulesets" panel — see renderRulesets.
  const extraLists: [string, keyof Settings][] = [
    ['aggressive-pruning', 'aggressivePruning'],
    ['resume-playback', 'resumePlayback'],
    ['yt-hide-shorts', 'ytHideShorts'],
    ['yt-disable-endcards', 'ytDisableEndCards'],
    ['yt-dismiss-stillwatching', 'ytDismissStillWatching'],
    ['defuse-anti-adblock', 'defuseAntiAdblock'],
    ['telemetry', 'telemetryEnabled'],
    ['filter-updates', 'filterUpdatesEnabled'],
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

  // Filter-update status line + manual "check now".
  const fuStatusEl = $<HTMLElement>('filter-update-status')
  const fuCheckEl = $<HTMLButtonElement>('filter-update-check')
  const renderFilterUpdate = (s: FilterUpdateStatus) => {
    if (!s.enabled) {
      fuStatusEl.textContent =
        'Filter auto-updates are off (or Local-only mode is on). Using bundled lists.'
    } else if (s.lastSuccess) {
      const when = new Date(s.lastSuccess).toLocaleString()
      const ver = s.listVersion ? ` (${s.listVersion})` : ''
      const shards = s.shardsApplied
        ? ` · ${s.shardsApplied} shard${s.shardsApplied === 1 ? '' : 's'} refreshed`
        : ''
      fuStatusEl.textContent = `Filters last updated ${when}${ver}${shards}.`
    } else if (s.lastError) {
      fuStatusEl.textContent = `Last check failed: ${s.lastError}. Using bundled lists.`
    } else {
      fuStatusEl.textContent = 'Filter lists: bundled with this version.'
    }
  }
  const refreshFilterUpdate = async () => {
    try {
      renderFilterUpdate(
        await chrome.runtime.sendMessage({
          type: 'skipSensei:getFilterUpdateStatus',
        }),
      )
    } catch {
      /* SW asleep / no status yet — leave the default hint */
    }
  }
  await refreshFilterUpdate()
  // The startup check initFilterUpdates() fires usually lands AFTER this first
  // render, which would leave the line reading "bundled with this version"
  // until the next reload even though shards just applied. setMeta() writes the
  // meta key on every completed check, so re-render whenever it changes — that
  // covers both the startup race and a background check finishing while this
  // page sits open.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && FILTER_UPDATE_META_KEY in changes) {
      void refreshFilterUpdate()
    }
  })
  fuCheckEl.addEventListener('click', async () => {
    fuCheckEl.disabled = true
    const prev = fuStatusEl.textContent
    fuStatusEl.textContent = 'Checking…'
    try {
      renderFilterUpdate(
        await chrome.runtime.sendMessage({
          type: 'skipSensei:checkFilterUpdates',
        }),
      )
    } catch {
      fuStatusEl.textContent = prev
    } finally {
      fuCheckEl.disabled = false
    }
  })

  // SponsorBlock enable + per-category checkboxes.
  const sbEnabledEl = $<HTMLInputElement>('sponsorblock-enabled')
  const sbCatEls = Array.from(
    document.querySelectorAll<HTMLInputElement>('[data-sbcat]'),
  )
  const syncSbUi = (settings: Settings) => {
    sbEnabledEl.checked = settings.sponsorBlockEnabled
    const set = new Set(settings.sponsorBlockCategories)
    for (const el of sbCatEls) el.checked = set.has(el.dataset.sbcat!)
    $('sponsorblock-categories').hidden = !settings.sponsorBlockEnabled
  }
  syncSbUi(loaded)
  sbEnabledEl.addEventListener('change', async () => {
    await save({ sponsorBlockEnabled: sbEnabledEl.checked })
    $('sponsorblock-categories').hidden = !sbEnabledEl.checked
  })
  for (const el of sbCatEls) {
    el.addEventListener('change', () => {
      const cats = sbCatEls.filter((e) => e.checked).map((e) => e.dataset.sbcat!)
      void save({ sponsorBlockCategories: cats })
    })
  }

  void renderRulesets()

  // Local-only mode overrides the provider, diagnostics, and SponsorBlock —
  // grey those out while it's on so the override is visible.
  const localOnlyEl = $<HTMLInputElement>('local-only')
  const applyLocalOnlyUi = (on: boolean) => {
    $<HTMLSelectElement>('provider').disabled = on
    $<HTMLInputElement>('telemetry').disabled = on
    sbEnabledEl.disabled = on
    for (const el of sbCatEls) el.disabled = on
    // Filter updates are also forced off by local-only (a background GET
    // would reveal the install) — grey them out like the rest of the
    // overridden controls instead of leaving a checkbox that does nothing.
    $<HTMLInputElement>('filter-updates').disabled = on
    $<HTMLButtonElement>('filter-update-check').disabled = on
  }
  localOnlyEl.checked = loaded.localOnlyMode
  applyLocalOnlyUi(loaded.localOnlyMode)
  localOnlyEl.addEventListener('change', async () => {
    await save({ localOnlyMode: localOnlyEl.checked })
    applyLocalOnlyUi(localOnlyEl.checked)
  })

  const debugLoggingEl = $<HTMLInputElement>('debug-logging')
  debugLoggingEl.checked = (await getSettings()).debugLogging
  debugLoggingEl.addEventListener('change', () =>
    save({ debugLogging: debugLoggingEl.checked }),
  )

  await renderAllowlist()
  const allowlistInput = $<HTMLInputElement>('allowlist-input')
  /** Mirror net-blocker's normalizeHost: scheme/path/port stripped, IDN →
   * punycode via URL. Stored entries must be in the same (punycode) form the
   * popup compares against tab hostnames and the DNR rule matches on —
   * storing raw Unicode made the pause toggle disagree with the actual rule.
   * Garbage input used to be stored silently and then dropped silently by
   * the rule sanitizer (site "paused" but not); now it's rejected visibly. */
  const normalizeAllowlistHost = (raw: string): string | null => {
    let s = raw
      .trim()
      .toLowerCase()
      .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
      .replace(/[/?#].*$/, '')
      .replace(/:\d+$/, '')
      .replace(/^\*\.?/, '')
      .replace(/\.$/, '')
      .replace(/^www\./, '')
    if (!s) return null
    try {
      s = new URL(`http://${s}`).hostname
    } catch {
      return null
    }
    return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(s)
      ? s
      : null
  }
  const addSite = async () => {
    const host = normalizeAllowlistHost(allowlistInput.value)
    if (!host) {
      if (allowlistInput.value.trim()) {
        allowlistInput.setCustomValidity('Enter a website like example.com')
        allowlistInput.reportValidity()
      }
      return
    }
    await setSiteAllowlisted(host, true)
    allowlistInput.value = ''
    await renderAllowlist()
  }
  allowlistInput.addEventListener('input', () =>
    allowlistInput.setCustomValidity(''),
  )
  $<HTMLButtonElement>('allowlist-add-btn').addEventListener('click', addSite)
  allowlistInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void addSite()
  })

  // About panel + support link (the hosted contact form; ?v= pre-tags the
  // submission with this install's version so bug reports carry it).
  const { version } = chrome.runtime.getManifest()
  $('about-version').textContent = version
  $<HTMLAnchorElement>('contact-link').href =
    `https://www.singlefinmedia.com/ad-sensei/support?v=${encodeURIComponent(version)}`
  $('review-link').addEventListener('click', () => usage('uiReviews'))

  // Reset panel (About). Targeted resets re-render in place; the wider ones
  // reload the page so every control reflects the new state.
  const DEFAULT_OPENCLAW_URL = 'http://127.0.0.1:18789/v1/chat/completions'
  const flashReset = (msg: string) => {
    const el = $('reset-result')
    el.textContent = msg
    el.hidden = false
  }
  $<HTMLButtonElement>('reset-toggles').addEventListener('click', async () => {
    // Keep AI config, paused sites, and (via storage) stats/cache/feedback.
    // telemetryEnabled and localOnlyMode are PRIVACY CONSENTS, not feature
    // toggles — a generic "back to defaults" must never silently re-opt the
    // user into diagnostics or out of local-only mode.
    await resetSettingsToDefaults([
      'apiKeys',
      'llmProvider',
      'model',
      'openclawUrl',
      'allowlist',
      'telemetryEnabled',
      'localOnlyMode',
    ])
    location.reload()
  })
  $<HTMLButtonElement>('reset-allowlist').addEventListener('click', async () => {
    render(await updateSettings({ allowlist: [] }))
    await renderAllowlist()
    flashReset('Paused sites cleared.')
  })
  $<HTMLButtonElement>('reset-feedback').addEventListener('click', async () => {
    await clearAdFeedback()
    flashReset('Ad-detection feedback forgotten.')
  })
  $<HTMLButtonElement>('reset-keys').addEventListener('click', async () => {
    render(
      await updateSettings({
        apiKeys: {},
        llmProvider: 'builtin',
        model: '',
        openclawUrl: DEFAULT_OPENCLAW_URL,
      }),
    )
    flashReset('API keys removed — back to on-device AI.')
  })

  // Full factory reset — two-step confirm.
  const resetAllBtn = $<HTMLButtonElement>('reset-all')
  const resetConfirm = $('reset-all-confirm')
  resetAllBtn.addEventListener('click', () => {
    resetConfirm.hidden = false
    resetAllBtn.hidden = true
  })
  $<HTMLButtonElement>('reset-all-no').addEventListener('click', () => {
    resetConfirm.hidden = true
    resetAllBtn.hidden = false
  })
  $<HTMLButtonElement>('reset-all-yes').addEventListener('click', async () => {
    const keepKeys = $<HTMLInputElement>('reset-keep-keys').checked
    await factoryReset({ keepApiKeys: keepKeys })
    location.reload()
  })

  // Activity & logs panel.
  setupLogTabs()
  $<HTMLButtonElement>('logs-reload').addEventListener('click', renderLogs)
  $<HTMLButtonElement>('clear-activity').addEventListener('click', async () => {
    await clearActivityLog()
    logShown.activity = LOG_PAGE
    void renderActivity()
  })
  $<HTMLButtonElement>('clear-log').addEventListener('click', async () => {
    await clearSettingsLog()
    logShown.settings = LOG_PAGE
    void renderSettingsHistory()
  })
  const clearCacheEl = $<HTMLButtonElement>('clear-cache')
  clearCacheEl.addEventListener('click', async () => {
    clearCacheEl.disabled = true
    await clearAnalysisCache()
    clearCacheEl.disabled = false
    logShown.cache = LOG_PAGE
    void renderCacheTable()
  })

  // Reset statistics (Analytics panel).
  const resetStatsEl = $<HTMLButtonElement>('reset-stats')
  const resetStatsResultEl = $('reset-stats-result')
  resetStatsEl.addEventListener('click', async () => {
    resetStatsEl.disabled = true
    await chrome.runtime
      .sendMessage({ type: 'skipSensei:resetStats' })
      .catch(() => {})
    resetStatsResultEl.textContent = 'Statistics reset to zero.'
    resetStatsEl.disabled = false
    void renderAnalytics()
  })

  setupNav()
}

void main()
