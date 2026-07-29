/**
 * Domain-specific cosmetic filters (service-worker side).
 *
 * scripts/build-cosmetic-filters.mjs compiles the `domain##selector` specific-
 * hiding rules (and their `#@#` unhide exceptions) out of the AdGuard Base +
 * Mobile filter text we already bundle, sharded by hostname. This module reads
 * the one shard a page needs and answers the content script's lookup.
 *
 * It lives in the service worker rather than the content script so the shard
 * files never need `web_accessible_resources` — a page could otherwise fetch a
 * known extension URL and fingerprint the extension.
 */

/** Keep byte-identical with scripts/build-cosmetic-filters.mjs. */
const SHARD_COUNT = 128

/** 32-bit FNV-1a. Keep identical with scripts/build-cosmetic-filters.mjs. */
function fnv1a(str: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/** Last two labels. Keep identical with scripts/build-cosmetic-filters.mjs. */
function groupKey(hostname: string): string {
  const labels = hostname.split('.')
  return labels.length >= 2 ? labels.slice(-2).join('.') : hostname
}

interface Shard {
  hide: Record<string, string[]>
  unhide: Record<string, string[]>
}

/** storage.local key holding a differential-update override for a shard. The
 * filter-updates module writes these; a present override wins over the bundled
 * shard. Keep the prefix identical with src/filter-updates.ts. */
export const cosmeticOverrideKey = (index: number): string =>
  `skipSensei.filterShard.cosmetic.${index}`

/** Shards are stable within an update cycle — cache them for the worker's life.
 * filter-updates.ts calls invalidateShardCache() after applying an override so
 * the next lookup re-reads the new data instead of the bundled shard. */
const shardCache = new Map<number, Shard | null>()

/** Drop cached shards (all, or a specific set) so freshly-applied overrides
 * take effect without waiting for a service-worker restart. */
export function invalidateShardCache(indices?: number[]): void {
  if (!indices) shardCache.clear()
  else for (const i of indices) shardCache.delete(i)
}

async function loadShard(index: number): Promise<Shard | null> {
  const cached = shardCache.get(index)
  if (cached !== undefined) return cached
  let shard: Shard | null = null
  try {
    // A differential update may have replaced this shard with a newer version;
    // it's stored under the override key. Fall back to the bundled artifact.
    const key = cosmeticOverrideKey(index)
    const stored = await chrome.storage.local.get(key)
    const override = stored[key] as Shard | undefined
    if (override && override.hide && override.unhide) {
      shard = override
    } else {
      const url = chrome.runtime.getURL(`cosmetic/${index}.json`)
      shard = (await (await fetch(url)).json()) as Shard
    }
  } catch {
    // Missing/corrupt shard — cosmetic filtering degrades to the built-in
    // selectors rather than breaking the content script.
    shard = null
  }
  shardCache.set(index, shard)
  return shard
}

/**
 * Multi-part public suffixes (eTLDs). Excluding only the final label isn't
 * enough: for example.co.uk the parent-domain walk would emit "co.uk", and a
 * list rule keyed on it would apply across every UK site. Common second-level
 * registries; not the full PSL — a miss here only means one extra candidate
 * that almost certainly keys no rule, so completeness isn't safety-critical.
 */
const MULTI_PART_TLDS = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'net.uk', 'sch.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'asn.au', 'id.au',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp',
  'co.nz', 'net.nz', 'org.nz', 'govt.nz',
  'com.br', 'net.br', 'org.br', 'gov.br',
  'com.mx', 'org.mx', 'net.mx',
  'co.in', 'net.in', 'org.in', 'firm.in', 'gen.in', 'ind.in',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn',
  'com.tw', 'org.tw', 'idv.tw',
  'com.hk', 'org.hk', 'net.hk',
  'co.kr', 'or.kr', 'ne.kr', 'go.kr',
  'com.sg', 'org.sg', 'net.sg',
  'com.tr', 'org.tr', 'net.tr',
  'co.za', 'org.za', 'net.za', 'web.za',
  'com.ar', 'net.ar', 'org.ar',
  'com.co', 'net.co',
  'com.pe', 'com.ve', 'com.my', 'com.ph', 'com.pk', 'com.eg', 'com.sa',
  'com.vn', 'com.ua', 'net.ua', 'org.ua',
  'co.th', 'or.th', 'in.th',
  'co.id', 'or.id', 'web.id',
])

/**
 * Every rule domain that can apply to `hostname`: itself and each parent
 * domain, since a rule on `example.com` also covers `www.example.com`.
 * Public suffixes are not candidates — neither the bare TLD nor a multi-part
 * one like co.uk; matching either would apply a rule registry-wide.
 */
function candidateDomains(hostname: string): string[] {
  const labels = hostname.split('.')
  const out: string[] = []
  for (let i = 0; i + 1 < labels.length; i++) {
    const domain = labels.slice(i).join('.')
    if (MULTI_PART_TLDS.has(domain)) break
    out.push(domain)
  }
  return out
}

/**
 * Selectors to hide on `hostname`: the union of every matching domain's hide
 * rules, minus every matching domain's unhide exceptions. Exceptions are
 * applied last and across the whole candidate chain, so `example.com#@#.ad`
 * correctly cancels a `.ad` rule inherited from a parent domain.
 */
export async function getCosmeticFilters(hostname: string): Promise<string[]> {
  const host = hostname.toLowerCase()
  if (!host || !host.includes('.')) return []

  const shard = await loadShard(fnv1a(groupKey(host)) % SHARD_COUNT)
  if (!shard) return []

  const candidates = candidateDomains(host)
  const hide = new Set<string>()
  for (const domain of candidates) {
    for (const selector of shard.hide[domain] ?? []) hide.add(selector)
  }
  if (hide.size === 0) return []

  for (const domain of candidates) {
    for (const selector of shard.unhide[domain] ?? []) hide.delete(selector)
  }
  return [...hide]
}
