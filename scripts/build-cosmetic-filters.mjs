/**
 * Build domain-specific cosmetic filters ("smart middle") from the AdGuard
 * Base filter that we already bundle for the DNR rulesets. Re-run via
 * `npm run rulesets`.
 *
 * Source: @adguard/dnr-rulesets embeds the full filter TEXT as
 * `metadata.rawFilterList` on the first rule of each compiled ruleset — so
 * cosmetic rules come from the same pinned package as the network rules, with
 * no build-time network fetch and no second list to keep in sync.
 *
 * WHAT WE CONSUME, and why only this slice:
 *  - `domain##selector`  — specific hiding. Curated per site, so the breakage
 *    risk is low and it replaces hand-maintained per-site selectors.
 *  - `domain#@#selector` — unhide exceptions. MUST be honored: the list itself
 *    carves these out, and ignoring them means over-hiding real content.
 *
 * WHAT WE SKIP, deliberately:
 *  - `##selector` with no domain (generic hiding) — applies everywhere and is
 *    the main source of breakage. Our `:has()` heuristics cover this ground.
 *  - `#?#` / `#$#` procedural + ExtCSS rules — that's what the runtime
 *    heuristics and the AI gap-filler are for.
 *  - Rules with domain negations (`~sub.example.com`) or wildcard TLDs
 *    (`example.*`) — we can't express them in the flat hostname map below, and
 *    guessing would over-hide. Counts are logged, never silently dropped.
 *
 * OUTPUT: sharded so a page loads only the slice it needs (the whole set is
 * ~900KB of selector text). Shard = fnv1a(groupKey(domain)) % SHARD_COUNT,
 * where groupKey is the last two labels of the hostname. A page's own
 * groupKey selects exactly one shard, and every rule that could match that
 * page — `example.com` and `sub.example.com` alike — hashes into it.
 *
 * NOTE: groupKey/fnv1a/SHARD_COUNT are duplicated in
 * src/cosmetic-filters.ts and MUST stay identical. Both are a few lines and
 * fully specified; a mismatch shows up immediately as "no rules for a domain
 * that has rules" (see the self-check printed at the end of this script).
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'

const SRC =
  'node_modules/@adguard/dnr-rulesets/dist/filters/chromium-mv3/declarative'
const OUT = 'public/cosmetic'

// Ruleset ids whose cosmetic rules we consume (AdGuard Base + Mobile Ads),
// matching the ad-blocking rulesets in build-rulesets.mjs.
const SOURCE_RULESETS = [2, 11]

export const SHARD_COUNT = 128

/** 32-bit FNV-1a. Keep byte-identical with src/cosmetic-filters.ts. */
export function fnv1a(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/** Last two labels of a hostname. Keep identical with src/cosmetic-filters.ts.
 * Intentionally NOT public-suffix aware: `bbc.co.uk` and `co.uk` both group
 * under `co.uk`, which only affects shard balance, never correctness — both
 * sides compute it the same way, so a page always looks in the right shard. */
export function groupKey(hostname) {
  const labels = hostname.split('.')
  return labels.length >= 2 ? labels.slice(-2).join('.') : hostname
}

export function shardOf(hostname) {
  return fnv1a(groupKey(hostname)) % SHARD_COUNT
}

/** ExtCSS / procedural pseudo-classes that can appear inside a plain `##`
 * rule. querySelector can't run them, so the whole selector is unusable. */
const EXTENDED_SYNTAX = [
  ':contains(',
  ':has-text(',
  ':matches-css',
  ':matches-attr',
  ':matches-property',
  ':xpath(',
  ':nth-ancestor(',
  ':upward(',
  ':remove()',
  ':min-text-length',
  ':style(',
  ':if(',
  ':if-not(',
  '-abp-',
]

function isUsableSelector(sel) {
  if (!sel) return false
  return !EXTENDED_SYNTAX.some((token) => sel.includes(token))
}

const stats = {
  hideRules: 0,
  unhideRules: 0,
  skippedGeneric: 0,
  skippedProcedural: 0,
  skippedExtCss: 0,
  skippedNegation: 0,
  skippedWildcard: 0,
}

/** hostname -> Set(selector) */
const hide = new Map()
const unhide = new Map()

function add(map, domain, selector) {
  let set = map.get(domain)
  if (!set) map.set(domain, (set = new Set()))
  set.add(selector)
}

function parseLine(line) {
  if (!line || line.startsWith('!') || line.startsWith('[')) return

  // Procedural / CSS-injection / scriptlet rules — not our layer.
  if (line.includes('#?#') || line.includes('#$#') || line.includes('#%#')) {
    if (line.includes('##') === false) stats.skippedProcedural++
    else stats.skippedProcedural++
    return
  }

  const isUnhide = line.includes('#@#')
  const sep = isUnhide ? '#@#' : '##'
  const idx = line.indexOf(sep)
  if (idx === -1) return // network rule

  const domainPart = line.slice(0, idx)
  const selector = line.slice(idx + sep.length).trim()

  // Generic (undomained) hiding rules apply to every site — highest breakage
  // risk, and the layer we deliberately don't take from the list.
  if (domainPart === '') {
    stats.skippedGeneric++
    return
  }
  if (!isUsableSelector(selector)) {
    stats.skippedExtCss++
    return
  }

  const domains = domainPart.split(',')
  // A negation makes the rule "everywhere except X" — inexpressible here.
  if (domains.some((d) => d.startsWith('~'))) {
    stats.skippedNegation++
    return
  }

  let added = false
  for (const domain of domains) {
    const d = domain.trim().toLowerCase()
    if (!d) continue
    if (d.includes('*')) {
      stats.skippedWildcard++
      continue
    }
    add(isUnhide ? unhide : hide, d, selector)
    added = true
  }
  if (added) {
    if (isUnhide) stats.unhideRules++
    else stats.hideRules++
  }
}

for (const id of SOURCE_RULESETS) {
  const path = `${SRC}/ruleset_${id}/ruleset_${id}.json`
  const compiled = JSON.parse(readFileSync(path, 'utf8'))
  const raw = compiled[0]?.metadata?.rawFilterList
  if (!raw) throw new Error(`ruleset_${id}: no rawFilterList in metadata`)
  for (const line of raw.split('\n')) parseLine(line.trim())
}

// An unhide rule only ever cancels a hide rule; a domain that has unhide
// entries but no hide entries anywhere is dead weight in the shard.
for (const domain of [...unhide.keys()]) {
  if (!hide.has(domain)) {
    // The exception may still apply to a PARENT domain's rules, so keep it if
    // any suffix of it has hide rules.
    const labels = domain.split('.')
    const hasParentRule = labels.some((_, i) => hide.has(labels.slice(i).join('.')))
    if (!hasParentRule) unhide.delete(domain)
  }
}

// Bucket into shards.
const shards = Array.from({ length: SHARD_COUNT }, () => ({ hide: {}, unhide: {} }))
for (const [domain, sels] of hide) {
  shards[shardOf(domain)].hide[domain] = [...sels]
}
for (const [domain, sels] of unhide) {
  shards[shardOf(domain)].unhide[domain] = [...sels]
}

if (existsSync(OUT)) rmSync(OUT, { recursive: true })
mkdirSync(OUT, { recursive: true })

let totalBytes = 0
let maxBytes = 0
for (let i = 0; i < SHARD_COUNT; i++) {
  const json = JSON.stringify(shards[i])
  totalBytes += json.length
  maxBytes = Math.max(maxBytes, json.length)
  writeFileSync(`${OUT}/${i}.json`, json)
}

const kb = (n) => `${(n / 1024).toFixed(0)}KB`
console.log(
  `cosmetic: ${stats.hideRules} hide rules over ${hide.size} domains, ` +
    `${stats.unhideRules} unhide exceptions over ${unhide.size} domains`,
)
console.log(
  `cosmetic: ${SHARD_COUNT} shards, ${kb(totalBytes)} total, ${kb(maxBytes)} largest`,
)
console.log(
  `cosmetic: skipped ${stats.skippedGeneric} generic, ` +
    `${stats.skippedProcedural} procedural, ${stats.skippedExtCss} extended-syntax, ` +
    `${stats.skippedNegation} negated, ${stats.skippedWildcard} wildcard-domain`,
)

// Self-check: these must resolve to a shard that actually contains the rules.
// If groupKey/fnv1a ever drift from the runtime copy, the runtime finds
// nothing for these well-known hosts and the live check catches it.
for (const host of ['www.msn.com', 'timesofindia.indiatimes.com', 'yahoo.com']) {
  const s = shardOf(host)
  const bucket = shards[s].hide
  const hit = Object.keys(bucket).filter(
    (d) => host === d || host.endsWith(`.${d}`),
  )
  console.log(`cosmetic: ${host} -> shard ${s}, ${hit.length} matching rule domains`)
}
