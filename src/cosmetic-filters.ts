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

/** Shards are immutable build artifacts — cache them for the worker's life. */
const shardCache = new Map<number, Shard | null>()

async function loadShard(index: number): Promise<Shard | null> {
  const cached = shardCache.get(index)
  if (cached !== undefined) return cached
  let shard: Shard | null = null
  try {
    const url = chrome.runtime.getURL(`cosmetic/${index}.json`)
    shard = (await (await fetch(url)).json()) as Shard
  } catch {
    // Missing/corrupt shard — cosmetic filtering degrades to the built-in
    // selectors rather than breaking the content script.
    shard = null
  }
  shardCache.set(index, shard)
  return shard
}

/**
 * Every rule domain that can apply to `hostname`: itself and each parent
 * domain, since a rule on `example.com` also covers `www.example.com`. The
 * bare TLD is not a candidate — no rule is keyed on it, and matching one would
 * apply a rule site-wide across a whole TLD.
 */
function candidateDomains(hostname: string): string[] {
  const labels = hostname.split('.')
  const out: string[] = []
  for (let i = 0; i + 1 < labels.length; i++) out.push(labels.slice(i).join('.'))
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
