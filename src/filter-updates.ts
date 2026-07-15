import { getSettings } from './storage'
import { cosmeticOverrideKey, invalidateShardCache } from './cosmetic-filters'
import { reportEvent } from './error-reporting'
import type { FilterUpdateStatus } from './types'

/**
 * Differential filter-list updates (service-worker side).
 *
 * The bundled cosmetic-filter shards (src/cosmetic-filters.ts) break faster
 * than we ship extension releases — a site renames an ad class and its rule is
 * dead until the next version clears Web Store review. This module refreshes
 * that DATA between releases, ABP-style: fetch a manifest, download only the
 * shards whose content hash changed, verify each against the manifest hash,
 * and store it as an override the shard loader prefers.
 *
 * CWS-safe by construction: we fetch DATA only — JSON maps of
 * `domain -> css-selector[]`. No code is ever fetched or evaluated. Every
 * payload is SHA-256-verified against the manifest, size-capped, shape-checked,
 * and sanitized (structural/universal selectors stripped) before it is applied;
 * anything that fails is skipped and the previously-applied (or bundled) data
 * stays in place. The mechanism fails closed and never throws into the worker.
 *
 * Network posture: a plain cross-origin GET with `credentials:'omit'` (same as
 * error-reporting.ts) — the update host serves the payload with permissive
 * CORS, so NO host permission is needed. The request reveals only that an
 * install is running and its coarse version, so it's gated exactly like
 * telemetry: the `filterUpdatesEnabled` setting, and never in localOnlyMode.
 *
 * NOT YET COVERED (deliberate): network-level DNR rules. Static rulesets can't
 * be remote-updated by Chrome at all, and the only runtime path — dynamic
 * rules — is capped and currently owned wholesale by syncAllowlist() in
 * net-blocker.ts (it clears ALL dynamic rules on every allowlist change,
 * including the YouTube NETWORK_EXEMPT exemption). Adding a remote block-domain
 * supplement means first refactoring that to a reserved rule-id range; tracked
 * as a follow-up rather than rushed in alongside the cosmetic path.
 */

/**
 * Where the payload is served. Host-agnostic: reachability depends only on the
 * host returning `Access-Control-Allow-Origin: *`, not on any manifest grant.
 * Baked to the landing Vercel alias DIRECTLY (not the singlefinmedia.com
 * /ad-sensei proxy) — same rationale as the telemetry endpoints: no dependency
 * on the singlefin rewrite, and the /ad-sensei path has a trailing-slash loop.
 * Served as static files under landing/filters/ (CORS via landing/vercel.json):
 * `<UPDATE_BASE>/manifest.json` and `<UPDATE_BASE>/cosmetic/<i>.json`. The build
 * script (scripts/build-filter-payload.mjs) emits exactly that directory.
 */
const UPDATE_BASE = 'https://landing-beta-three-23.vercel.app/filters'

/** Keep byte-identical with src/cosmetic-filters.ts and the build script. */
const SHARD_COUNT = 128
/** Payload format version this client understands. */
const SUPPORTED_SCHEMA = 1

const ALARM_NAME = 'skipSensei.filterUpdate'
const CHECK_PERIOD_MIN = 720 // 12h background cadence
const MIN_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000 // throttle wake/manual spam
const FETCH_TIMEOUT_MS = 10_000
const MAX_MANIFEST_BYTES = 256 * 1024
const MAX_SHARD_BYTES = 512 * 1024 // bundled max ~69KB; generous headroom
const MAX_SELECTORS_PER_DOMAIN = 200

const META_KEY = 'skipSensei.filterUpdate'

interface UpdateMeta {
  schema: number
  listVersion: string | null
  generatedAt: string | null
  appliedHashes: Record<string, string> // shard index -> sha256 hex
  lastCheck: number | null
  lastSuccess: number | null
  lastError: string | null
}

interface Manifest {
  schema: number
  listVersion: string
  generatedAt: string
  minAppVersion?: string
  cosmetic: { shardCount: number; shards: Record<string, string> }
}

interface Shard {
  hide: Record<string, string[]>
  unhide: Record<string, string[]>
}

const emptyMeta = (): UpdateMeta => ({
  schema: SUPPORTED_SCHEMA,
  listVersion: null,
  generatedAt: null,
  appliedHashes: {},
  lastCheck: null,
  lastSuccess: null,
  lastError: null,
})

async function getMeta(): Promise<UpdateMeta> {
  const r = await chrome.storage.local.get(META_KEY)
  return { ...emptyMeta(), ...(r[META_KEY] ?? {}) }
}
async function setMeta(meta: UpdateMeta): Promise<void> {
  await chrome.storage.local.set({ [META_KEY]: meta })
}

/** SHA-256 of raw bytes as lowercase hex — must match the build script's hash. */
async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** Fetch with a hard timeout and byte cap. Returns the raw bytes (for hashing)
 * and decoded text, or throws. */
async function fetchCapped(
  url: string,
  maxBytes: number,
): Promise<{ bytes: ArrayBuffer; text: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'GET',
      credentials: 'omit',
      cache: 'no-store',
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const bytes = await res.arrayBuffer()
    if (bytes.byteLength > maxBytes)
      throw new Error(`too large: ${bytes.byteLength} > ${maxBytes}`)
    return { bytes, text: new TextDecoder().decode(bytes) }
  } finally {
    clearTimeout(timer)
  }
}

/** Compare dotted version strings numerically ("0.2.20" <= "0.2.23"). */
function versionAtLeast(have: string, need: string): boolean {
  const a = have.split('.').map((n) => parseInt(n, 10) || 0)
  const b = need.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x > y
  }
  return true
}

function isValidManifest(obj: unknown): obj is Manifest {
  if (!obj || typeof obj !== 'object') return false
  const m = obj as Record<string, unknown>
  if (m.schema !== SUPPORTED_SCHEMA) return false
  if (typeof m.listVersion !== 'string' || !m.listVersion) return false
  if (typeof m.generatedAt !== 'string') return false
  const c = m.cosmetic as Record<string, unknown> | undefined
  if (!c || c.shardCount !== SHARD_COUNT) return false
  const shards = c.shards as Record<string, unknown> | undefined
  if (!shards || typeof shards !== 'object') return false
  for (const [k, v] of Object.entries(shards)) {
    const i = Number(k)
    if (!Number.isInteger(i) || i < 0 || i >= SHARD_COUNT) return false
    if (typeof v !== 'string' || !/^[0-9a-f]{64}$/.test(v)) return false
  }
  return true
}

/** A selector we refuse to apply from remote data no matter its source — one
 * of these hides most of a page and can't be a legitimate ad rule. */
function isDangerousSelector(sel: string): boolean {
  const s = sel.trim().toLowerCase()
  if (!s) return true
  if (s === '*' || s === 'html' || s === 'body' || s === ':root') return true
  // A comma-joined rule containing a bare universal/structural term.
  return /(^|,)\s*(\*|html|body|:root)\s*(,|$)/.test(s)
}

/** Validate + sanitize a downloaded shard into the {hide,unhide} shape the
 * loader expects. Returns null if the shape is unusable. */
function sanitizeShard(obj: unknown): Shard | null {
  if (!obj || typeof obj !== 'object') return null
  const raw = obj as Record<string, unknown>
  const clean = (section: unknown): Record<string, string[]> => {
    const out: Record<string, string[]> = {}
    if (!section || typeof section !== 'object') return out
    for (const [domain, sels] of Object.entries(section as object)) {
      if (typeof domain !== 'string' || !Array.isArray(sels)) continue
      const kept = (sels as unknown[])
        .filter((s): s is string => typeof s === 'string')
        .filter((s) => !isDangerousSelector(s))
        .slice(0, MAX_SELECTORS_PER_DOMAIN)
      if (kept.length) out[domain] = kept
    }
    return out
  }
  return { hide: clean(raw.hide), unhide: clean(raw.unhide) }
}

let inFlight = false

/**
 * Check the update host and apply any changed cosmetic shards. Self-throttling
 * (skips if checked within MIN_CHECK_INTERVAL unless `force`). Never throws.
 * Returns the resulting status.
 */
export async function checkForUpdates(force = false): Promise<FilterUpdateStatus> {
  const settings = await getSettings()
  if (!settings.filterUpdatesEnabled || settings.localOnlyMode) {
    return toStatus(await getMeta(), false)
  }
  if (inFlight) return toStatus(await getMeta(), true)
  inFlight = true
  const meta = await getMeta()
  try {
    const now = Date.now()
    if (!force && meta.lastCheck && now - meta.lastCheck < MIN_CHECK_INTERVAL_MS) {
      return toStatus(meta, true)
    }
    meta.lastCheck = now

    const { text } = await fetchCapped(`${UPDATE_BASE}/manifest.json`, MAX_MANIFEST_BYTES)
    let manifest: unknown
    try {
      manifest = JSON.parse(text)
    } catch {
      throw new Error('manifest not JSON')
    }
    if (!isValidManifest(manifest)) throw new Error('manifest failed validation')
    const app = chrome.runtime.getManifest().version
    if (manifest.minAppVersion && !versionAtLeast(app, manifest.minAppVersion)) {
      // Payload needs a newer extension than this one — leave bundled data.
      meta.lastError = `needs app >= ${manifest.minAppVersion}`
      await setMeta(meta)
      return toStatus(meta, true)
    }

    // Download only shards whose hash differs from what we've applied. Keying
    // off appliedHashes (not listVersion) means a shard skipped last time — a
    // hash mismatch, a transient fetch error — is retried on the next check,
    // even if the published listVersion hasn't moved since.
    const changed = Object.entries(manifest.cosmetic.shards).filter(
      ([i, hash]) => meta.appliedHashes[i] !== hash,
    )
    if (changed.length === 0) {
      // Everything the manifest lists is already applied — the differential no-op.
      meta.listVersion = manifest.listVersion
      meta.generatedAt = manifest.generatedAt
      meta.lastError = null
      meta.lastSuccess = now
      await setMeta(meta)
      return toStatus(meta, true)
    }
    const applied: number[] = []
    for (const [i, wantHash] of changed) {
      try {
        const { bytes, text: shardText } = await fetchCapped(
          `${UPDATE_BASE}/cosmetic/${i}.json`,
          MAX_SHARD_BYTES,
        )
        if ((await sha256Hex(bytes)) !== wantHash) throw new Error('hash mismatch')
        const shard = sanitizeShard(JSON.parse(shardText))
        if (!shard) throw new Error('bad shard shape')
        await chrome.storage.local.set({ [cosmeticOverrideKey(Number(i))]: shard })
        meta.appliedHashes[i] = wantHash
        applied.push(Number(i))
      } catch {
        // Skip just this shard; keep its previous data. One bad shard must not
        // abort the whole update or corrupt filtering.
      }
    }
    invalidateShardCache(applied)

    meta.listVersion = manifest.listVersion
    meta.generatedAt = manifest.generatedAt
    meta.lastSuccess = now
    meta.lastError = applied.length < changed.length ? `${changed.length - applied.length} shard(s) skipped` : null
    await setMeta(meta)
    void reportEvent('filter_update', {
      version: manifest.listVersion,
      changed: String(changed.length),
      applied: String(applied.length),
    })
    return toStatus(meta, true)
  } catch (e) {
    meta.lastError = e instanceof Error ? e.message.slice(0, 120) : 'update failed'
    await setMeta(meta)
    return toStatus(meta, true)
  } finally {
    inFlight = false
  }
}

function toStatus(meta: UpdateMeta, enabled: boolean): FilterUpdateStatus {
  return {
    enabled,
    listVersion: meta.listVersion,
    generatedAt: meta.generatedAt,
    lastCheck: meta.lastCheck,
    lastSuccess: meta.lastSuccess,
    lastError: meta.lastError,
    shardsApplied: Object.keys(meta.appliedHashes).length,
  }
}

export async function getFilterUpdateStatus(): Promise<FilterUpdateStatus> {
  const settings = await getSettings()
  return toStatus(
    await getMeta(),
    settings.filterUpdatesEnabled && !settings.localOnlyMode,
  )
}

/** Register the periodic alarm + listener (synchronously, MV3-required) and
 * kick a throttled check on cold start. Safe to call on every worker wake —
 * the check self-throttles via stored lastCheck. */
export function initFilterUpdates(): void {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_NAME) void checkForUpdates(false)
  })
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: CHECK_PERIOD_MIN })
  void checkForUpdates(false)
}
