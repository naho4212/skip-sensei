// Produce the Chrome Web Store build variant from a finished full build.
//
// The full (load-unpacked) build keeps the outbound YouTube player-request
// spoof in prune-main.js; the CWS artifact must not carry request tampering.
// Rather than maintaining two source files (or letting the difference ride on
// whichever git branch happens to be checked out — which nearly shipped the
// wrong Desktop build once), the spoof is fenced with CWS-STRIP markers in
// the ONE source file and cut out here, at artifact time:
//
//   .output/chrome-mv3/       → full build (untouched)
//   .output/chrome-mv3-cws/   → CWS build (spoof stripped)
//   .output/ad-sensei-cws-v<version>.zip
//
// Run via `npm run build:cws` (which builds first). Fails loudly if the
// markers are missing (source drift) or the stripped file doesn't parse.

import { execFileSync, execSync } from 'node:child_process'
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const src = resolve(root, '.output/chrome-mv3')
const dst = resolve(root, '.output/chrome-mv3-cws')

// Loud heads-up when building off-main: the artifact reflects THIS checkout.
try {
  const branch = execSync('git branch --show-current', { cwd: root })
    .toString()
    .trim()
  if (branch !== 'main') {
    console.warn(
      `\n⚠️  Building from branch "${branch}", not main — the artifact will include this branch's changes.\n`,
    )
  }
} catch {
  /* not a git checkout — nothing to warn about */
}

if (!existsSync(src)) {
  console.error('No .output/chrome-mv3 build found — run `npm run build` first.')
  process.exit(1)
}

rmSync(dst, { recursive: true, force: true })
cpSync(src, dst, {
  recursive: true,
  filter: (p) => !p.includes('_metadata'),
})

const prunePath = resolve(dst, 'prune-main.js')
const original = readFileSync(prunePath, 'utf8')
const STRIP_RE = /\n?[ \t]*\/\* CWS-STRIP-START[\s\S]*?CWS-STRIP-END \*\//g
const markers = original.match(STRIP_RE)
if (!markers || markers.length !== 2) {
  console.error(
    `Expected exactly 2 CWS-STRIP blocks in prune-main.js, found ${markers?.length ?? 0} — markers drifted, refusing to ship.`,
  )
  process.exit(1)
}
const stripped = original.replace(STRIP_RE, '')
if (/spoofPlayerBody|clientScreen|PLAYER_PATH/.test(stripped)) {
  console.error('Spoof identifiers survived the strip — refusing to ship.')
  process.exit(1)
}
writeFileSync(prunePath, stripped)
// The stripped file must still parse — a broken pruner would kill YT blocking.
execFileSync(process.execPath, ['--check', prunePath])

const version = JSON.parse(
  readFileSync(resolve(root, 'package.json'), 'utf8'),
).version
const zipPath = resolve(root, `.output/ad-sensei-cws-v${version}.zip`)
rmSync(zipPath, { force: true })
execSync(`zip -qr '${zipPath}' . -x '.*'`, { cwd: dst })

console.log(`CWS build ready (spoof stripped, ${markers.length} blocks):`)
console.log(`  ${dst}`)
console.log(`  ${zipPath}`)
