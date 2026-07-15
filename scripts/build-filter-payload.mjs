/**
 * Build the deployable differential-update payload from the compiled cosmetic
 * shards (public/cosmetic/, produced by build-cosmetic-filters.mjs).
 *
 * Output (filter-payload/) is a static directory to publish at the host the
 * extension's src/filter-updates.ts points at (UPDATE_BASE), served with
 * `Access-Control-Allow-Origin: *`:
 *
 *   filter-payload/manifest.json        <- version + per-shard SHA-256
 *   filter-payload/cosmetic/<i>.json    <- byte-identical copy of each shard
 *
 * The per-shard hash is taken over the EXACT bytes written here, which are the
 * exact bytes the client fetches and re-hashes — so verification matches. The
 * listVersion is content-derived (changes only when shard content changes), so
 * republishing an unchanged build is a client-side no-op.
 *
 * Run: `npm run filter-payload` (chains the cosmetic build first).
 */
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  existsSync,
  readdirSync,
} from 'node:fs'
import { createHash } from 'node:crypto'

const SRC = 'public/cosmetic'
const OUT = 'filter-payload'
const SHARD_COUNT = 128
const SCHEMA = 1
// Floor version: the first extension release that understands schema 1. Older
// installs ignore the payload (they have no updater); this documents intent.
const MIN_APP_VERSION = '0.2.24'

if (!existsSync(SRC)) {
  console.error(
    `${SRC} missing — run "node scripts/build-cosmetic-filters.mjs" first.`,
  )
  process.exit(1)
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

if (existsSync(OUT)) rmSync(OUT, { recursive: true })
mkdirSync(`${OUT}/cosmetic`, { recursive: true })

const shards = {}
let present = 0
let totalBytes = 0
for (let i = 0; i < SHARD_COUNT; i++) {
  const file = `${SRC}/${i}.json`
  if (!existsSync(file)) continue // sparse shard (no rules hashed into it)
  const bytes = readFileSync(file) // Buffer — hash & copy the exact bytes
  shards[String(i)] = sha256(bytes)
  writeFileSync(`${OUT}/cosmetic/${i}.json`, bytes)
  present++
  totalBytes += bytes.length
}

// Content-derived version: sha of the sorted per-shard hashes, so it only moves
// when the actual filter content moves.
const combined = sha256(
  Object.keys(shards)
    .sort((a, b) => Number(a) - Number(b))
    .map((k) => `${k}:${shards[k]}`)
    .join('\n'),
).slice(0, 12)
const listVersion = `${pkg.version}+${combined}`

// generatedAt is informational only (shown in options); the client keys updates
// off listVersion + per-shard hashes, never off this timestamp.
const manifest = {
  schema: SCHEMA,
  listVersion,
  generatedAt: new Date().toISOString(),
  minAppVersion: MIN_APP_VERSION,
  cosmetic: { shardCount: SHARD_COUNT, shards },
}
writeFileSync(`${OUT}/manifest.json`, JSON.stringify(manifest))

const kb = (n) => `${(n / 1024).toFixed(0)}KB`
console.log(`filter-payload: listVersion ${listVersion}`)
console.log(
  `filter-payload: ${present}/${SHARD_COUNT} shards, ${kb(totalBytes)} total`,
)
console.log(`filter-payload: wrote ${OUT}/manifest.json + ${OUT}/cosmetic/*.json`)
console.log(
  `filter-payload: publish ${OUT}/ at UPDATE_BASE with Access-Control-Allow-Origin: *`,
)
