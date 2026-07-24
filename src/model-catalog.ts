import type { LlmProvider, Settings } from './types'

/**
 * On-demand model discovery. Each cloud provider exposes a models endpoint;
 * this fetches the live list with the user's saved key, filters it to text
 * chat models (dropping embeddings / audio / vision-only / image / moderation),
 * and returns `{id, label}` entries the options dropdown can show below the
 * curated auto-updating aliases.
 *
 * This is opt-in (a "Refresh models" click), cached by the caller, and fails
 * soft: on any error the caller keeps the curated list. The per-provider
 * filters are best-effort — a new junk model slipping through is cosmetic, and
 * the curated aliases remain the recommended defaults regardless.
 */

export interface CatalogModel {
  id: string
  label: string
}

const FETCH_TIMEOUT_MS = 10_000
const MAX_MODELS = 60

/** Providers with a discoverable catalog. builtin runs on-device; openclaw's
 * "model" is an agent target, not a model id — neither has a list to fetch. */
export function supportsModelCatalog(provider: LlmProvider): boolean {
  return provider !== 'builtin' && provider !== 'openclaw'
}

export async function fetchModelCatalog(
  provider: LlmProvider,
  settings: Settings,
): Promise<CatalogModel[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const key = (settings.apiKeys[provider as keyof typeof settings.apiKeys] ?? '').trim()
    const { url, headers } = endpoint(provider, key)
    const res = await fetch(url, { headers, signal: controller.signal })
    if (!res.ok) {
      throw new Error(`${provider} models ${res.status}: ${(await res.text()).slice(0, 120)}`)
    }
    const data = await res.json()
    const models = parse(provider, data)
    // De-dupe, sort, cap. Keep insertion order for providers that pre-sort.
    const seen = new Set<string>()
    const out: CatalogModel[] = []
    for (const m of models) {
      if (!m.id || seen.has(m.id)) continue
      seen.add(m.id)
      out.push(m)
      if (out.length >= MAX_MODELS) break
    }
    return out
  } finally {
    clearTimeout(timer)
  }
}

function endpoint(
  provider: LlmProvider,
  key: string,
): { url: string; headers: Record<string, string> } {
  switch (provider) {
    case 'gemini':
      // Key in the query string for the native ListModels endpoint.
      return {
        url: `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}&pageSize=200`,
        headers: {},
      }
    case 'openai':
      return {
        url: 'https://api.openai.com/v1/models',
        headers: { authorization: `Bearer ${key}` },
      }
    case 'groq':
      return {
        url: 'https://api.groq.com/openai/v1/models',
        headers: { authorization: `Bearer ${key}` },
      }
    case 'openrouter':
      return {
        url: 'https://openrouter.ai/api/v1/models',
        headers: key ? { authorization: `Bearer ${key}` } : {},
      }
    case 'anthropic':
      return {
        url: 'https://api.anthropic.com/v1/models?limit=100',
        headers: {
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
      }
    case 'ollama':
      return { url: 'http://localhost:11434/api/tags', headers: {} }
    default:
      throw new Error(`no model catalog for ${provider}`)
  }
}

/** Names that are never a text chat model, across providers. */
const NON_CHAT =
  /embedding|embed|whisper|tts|audio|speech|transcrib|moderation|dall-?e|image|vision-only|imagen|aqa|guard|rerank|clip|codestral-embed/i

function parse(provider: LlmProvider, data: unknown): CatalogModel[] {
  const d = data as any
  switch (provider) {
    case 'gemini': {
      const list: any[] = Array.isArray(d?.models) ? d.models : []
      return list
        .filter(
          (m) =>
            Array.isArray(m?.supportedGenerationMethods) &&
            m.supportedGenerationMethods.includes('generateContent') &&
            !NON_CHAT.test(String(m?.name ?? '')),
        )
        .map((m) => {
          const id = String(m.name).replace(/^models\//, '')
          return { id, label: m.displayName ? `${id} · ${m.displayName}` : id }
        })
    }
    case 'openai':
    case 'groq': {
      const list: any[] = Array.isArray(d?.data) ? d.data : []
      return list
        .map((m) => String(m?.id ?? ''))
        .filter((id) => id && !NON_CHAT.test(id))
        .filter((id) =>
          provider === 'openai'
            ? /^(gpt-|o\d|chatgpt|o1|o3|o4)/.test(id)
            : true,
        )
        .sort()
        .map((id) => ({ id, label: id }))
    }
    case 'openrouter': {
      const list: any[] = Array.isArray(d?.data) ? d.data : []
      return list
        .filter((m) => {
          const modality = m?.architecture?.output_modalities
          const okModality = !Array.isArray(modality) || modality.includes('text')
          return okModality && !NON_CHAT.test(String(m?.id ?? ''))
        })
        .map((m) => ({
          id: String(m?.id ?? ''),
          label: m?.name ? `${m.id} · ${m.name}` : String(m?.id ?? ''),
        }))
        .filter((m) => m.id)
        // Free variants first — they're the ones this extension leans on.
        .sort((a, b) => Number(b.id.endsWith(':free')) - Number(a.id.endsWith(':free')))
    }
    case 'anthropic': {
      const list: any[] = Array.isArray(d?.data) ? d.data : []
      return list
        .map((m) => ({
          id: String(m?.id ?? ''),
          label: m?.display_name ? `${m.id} · ${m.display_name}` : String(m?.id ?? ''),
        }))
        .filter((m) => m.id && !NON_CHAT.test(m.id))
    }
    case 'ollama': {
      const list: any[] = Array.isArray(d?.models) ? d.models : []
      return list
        .map((m) => String(m?.name ?? ''))
        .filter((id) => id && !NON_CHAT.test(id))
        .map((id) => ({ id, label: id }))
    }
    default:
      return []
  }
}
