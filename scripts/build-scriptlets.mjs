/**
 * PROTOTYPE — parse the AdGuard scriptlet rules (`domain#%#//scriptlet(...)`)
 * out of the filter TEXT we already bundle, the same source the cosmetic-filter
 * build reads. Mirrors scripts/build-cosmetic-filters.mjs: parse → keep the
 * scriptlets our MAIN-world engine can run → shard by hostname → report.
 *
 * This is the data half of a filter-driven scriptlet engine (the ABP/uBO
 * "snippets" model). The runtime half is public/scriptlets-main.js, which today
 * runs a hand-curated per-hostname config; this generates that config from the
 * maintained list instead. Run: `node scripts/build-scriptlets.mjs`.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'

const SRC =
  'node_modules/@adguard/dnr-rulesets/dist/filters/chromium-mv3/declarative'
const SOURCE_RULESETS = [2, 11]
const OUT = 'public/scriptlets'
const SHARD_COUNT = 128

/** Scriptlets public/scriptlets-main.js already implements today. */
const IMPLEMENTED = new Set([
  'set-constant',
  'abort-on-property-read',
  'abort-on-property-write',
  'prevent-setTimeout',
  'prevent-addEventListener',
  'spoof-css',
])

/** High-value, self-contained scriptlets worth adding to the engine next
 * (no trusted/DOM-mutation complexity; pure JS-shim shape like the ones above). */
const PLANNED = new Set([
  'prevent-fetch',
  'prevent-xhr',
  'prevent-window-open',
  'prevent-setInterval',
  'abort-current-inline-script',
  'json-prune',
  'remove-attr',
  'remove-class',
])

// Keep byte-identical with src/cosmetic-filters.ts (reuse the same sharding).
function fnv1a(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}
function groupKey(hostname) {
  const labels = hostname.split('.')
  return labels.length >= 2 ? labels.slice(-2).join('.') : hostname
}
const shardOf = (h) => fnv1a(groupKey(h)) % SHARD_COUNT

/** Parse the argument list of //scriptlet('a', "b", ...) into a string[]. */
function parseArgs(inner) {
  const args = []
  const re = /(['"])((?:\\.|(?!\1).)*)\1/g
  let m
  while ((m = re.exec(inner))) args.push(m[2].replace(/\\(['"])/g, '$1'))
  return args
}

const stats = {
  total: 0,
  kept: 0,
  skippedGeneric: 0,
  skippedNegation: 0,
  skippedWildcard: 0,
  skippedUnsupported: 0,
}
const byName = {}
const byDomain = new Map() // hostname -> [{ name, args }]

for (const id of SOURCE_RULESETS) {
  const raw = JSON.parse(
    readFileSync(`${SRC}/ruleset_${id}/ruleset_${id}.json`, 'utf8'),
  )[0]?.metadata?.rawFilterList
  if (!raw) throw new Error(`ruleset_${id}: no rawFilterList`)

  for (const line of raw.split('\n')) {
    const idx = line.indexOf('#%#//scriptlet(')
    if (idx === -1) continue
    stats.total++

    const domainPart = line.slice(0, idx)
    const inner = line.slice(idx + '#%#//scriptlet('.length).replace(/\)\s*$/, '')
    const args = parseArgs(inner)
    if (args.length === 0) continue
    const [name, ...rest] = args

    byName[name] = (byName[name] || 0) + 1

    if (domainPart === '') { stats.skippedGeneric++; continue }
    if (!IMPLEMENTED.has(name) && !PLANNED.has(name)) {
      stats.skippedUnsupported++
      continue
    }
    const domains = domainPart.split(',')
    if (domains.some((d) => d.startsWith('~'))) { stats.skippedNegation++; continue }

    let added = false
    for (const raw of domains) {
      const d = raw.trim().toLowerCase()
      if (!d) continue
      if (d.includes('*')) { stats.skippedWildcard++; continue }
      let arr = byDomain.get(d)
      if (!arr) byDomain.set(d, (arr = []))
      arr.push({ name, args: rest })
      added = true
    }
    if (added) stats.kept++
  }
}

// Shard by hostname, same scheme as the cosmetic filters.
const shards = Array.from({ length: SHARD_COUNT }, () => ({}))
for (const [domain, rules] of byDomain) shards[shardOf(domain)][domain] = rules

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

// --- Coverage report --------------------------------------------------------
const kb = (n) => `${(n / 1024).toFixed(0)}KB`
const total = Object.values(byName).reduce((a, b) => a + b, 0)
const covered = [...IMPLEMENTED, ...PLANNED].reduce(
  (a, n) => a + (byName[n] || 0),
  0,
)
console.log(
  `scriptlets: ${stats.total} rules; ${stats.kept} kept over ${byDomain.size} domains ` +
    `(implemented + planned scriptlets only)`,
)
console.log(
  `scriptlets: ${SHARD_COUNT} shards, ${kb(totalBytes)} total, ${kb(maxBytes)} largest`,
)
console.log(
  `scriptlets: skipped ${stats.skippedUnsupported} unsupported-name, ` +
    `${stats.skippedGeneric} generic, ${stats.skippedNegation} negated, ` +
    `${stats.skippedWildcard} wildcard-domain`,
)
console.log(
  `scriptlets: coverage — ${covered}/${total} rules (${((100 * covered) / total).toFixed(0)}%) ` +
    `use a scriptlet we implement or plan to`,
)
console.log('\nTop scriptlets in the list (✓=implemented, +=planned, ·=not yet):')
for (const [name, count] of Object.entries(byName)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 18)) {
  const mark = IMPLEMENTED.has(name) ? '✓' : PLANNED.has(name) ? '+' : '·'
  console.log(`  ${mark} ${String(count).padStart(5)}  ${name}`)
}
