/**
 * Bump the patch version in manifest.config.ts and package.json in lockstep,
 * and print the new version to stdout (so CI can capture it). The manifest
 * version is the source of truth the build reads; package.json is kept in sync.
 *
 *   node scripts/bump-version.mjs          # 0.1.0 → 0.1.1
 */
import { readFileSync, writeFileSync } from 'node:fs'

const MANIFEST = 'manifest.config.ts'
const PKG = 'package.json'
const VERSION_RE = /version:\s*'(\d+)\.(\d+)\.(\d+)'/

let manifest = readFileSync(MANIFEST, 'utf8')
const match = manifest.match(VERSION_RE)
if (!match) {
  console.error(`No version: '...' found in ${MANIFEST}`)
  process.exit(1)
}
const [, major, minor, patch] = match
const next = `${major}.${minor}.${Number(patch) + 1}`

manifest = manifest.replace(VERSION_RE, `version: '${next}'`)
writeFileSync(MANIFEST, manifest)

const pkg = JSON.parse(readFileSync(PKG, 'utf8'))
pkg.version = next
writeFileSync(PKG, JSON.stringify(pkg, null, 2) + '\n')

process.stdout.write(next)
