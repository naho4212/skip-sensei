import {
  clearActivityLog,
  clearAnalysisCache,
  clearSettingsLog,
  getActivityLog,
  getCacheStats,
  getSettingsLog,
} from '../storage'
import type { Settings } from '../types'

const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T

const fmtBytes = (n: number) =>
  n >= 1_048_576
    ? `${(n / 1_048_576).toFixed(1)} MB`
    : n >= 1024
      ? `${(n / 1024).toFixed(1)} KB`
      : `${n} B`

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
const SETTING_LABELS: Partial<Record<keyof Settings | string, string>> = {
  masterEnabled: 'Ad Sensei enabled',
  adEngineEnabled: 'YouTube ad skipping',
  sponsorEngineEnabled: 'Sponsor detection',
  blockAllAds: 'Block all ads',
  blockTrackers: 'Block trackers & analytics',
  blockCookieNotices: 'Handle cookie-consent notices',
  blockSocial: 'Block social-media widgets',
  blockPopups: 'Block popup & overlay ads',
  allowlist: 'Paused sites',
  confidenceThreshold: 'Confidence threshold',
  showSkipToast: 'Skip toast',
  aiEnhancements: 'AI enhancements',
  debugLogging: 'Debug logging',
  telemetryEnabled: 'Anonymous error reports',
  llmProvider: 'AI provider',
  model: 'Model override',
  'apiKeys.gemini': 'Gemini API key',
  'apiKeys.groq': 'Groq API key',
  'apiKeys.openrouter': 'OpenRouter API key',
  'apiKeys.anthropic': 'Anthropic API key',
  'apiKeys.openai': 'OpenAI API key',
}

function cell(text: string, className?: string): HTMLTableCellElement {
  const td = document.createElement('td')
  td.textContent = text
  if (className) td.className = className
  return td
}

async function renderActivity() {
  const entries = await getActivityLog()
  const body = $<HTMLTableSectionElement>('activity-body')
  $('activity-empty').hidden = entries.length > 0
  $('activity-table').hidden = entries.length === 0
  body.replaceChildren(
    ...[...entries].reverse().map((entry) => {
      const tr = document.createElement('tr')
      tr.append(
        cell(fmtWhen(entry.at), 'when'),
        cell(entry.feature),
        cell(entry.action),
        cell(entry.site ?? '—', 'site'),
      )
      return tr
    }),
  )
}

async function renderSettingsLog() {
  const log = await getSettingsLog()
  const body = $<HTMLTableSectionElement>('settings-body')
  $('settings-empty').hidden = log.length > 0
  $('settings-table').hidden = log.length === 0
  body.replaceChildren(
    ...[...log].reverse().map((entry) => {
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
    }),
  )
}

async function renderCache() {
  const { entries, cacheBytes, totalBytes } = await getCacheStats()
  $('totals').innerHTML =
    `Analysis cache: <b>${fmtBytes(cacheBytes)}</b> across ` +
    `<b>${entries.length}</b> ${entries.length === 1 ? 'video' : 'videos'} · ` +
    `all extension storage (settings, stats, history, cache): <b>${fmtBytes(totalBytes)}</b>`

  const body = $<HTMLTableSectionElement>('cache-body')
  $('cache-empty').hidden = entries.length > 0
  $('cache-table').hidden = entries.length === 0
  body.replaceChildren(
    ...entries.map((entry) => {
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
    }),
  )
}

async function renderAll() {
  await Promise.all([renderActivity(), renderSettingsLog(), renderCache()])
}

function main() {
  $<HTMLButtonElement>('reload').addEventListener('click', () =>
    location.reload(),
  )
  $<HTMLButtonElement>('clear-activity').addEventListener('click', async () => {
    await clearActivityLog()
    await renderActivity()
  })
  $<HTMLButtonElement>('clear-log').addEventListener('click', async () => {
    await clearSettingsLog()
    await renderSettingsLog()
  })
  $<HTMLButtonElement>('clear-cache').addEventListener('click', async () => {
    await clearAnalysisCache()
    await renderCache()
  })
  void renderAll()
}

main()
