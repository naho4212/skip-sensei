/**
 * Bump the patch version in package.json, and print the new version to
 * stdout (so CI can capture it). package.json is the single source of
 * truth: WXT reads the manifest version from it at build time.
 *
 *   node scripts/bump-version.mjs          # 0.1.0 → 0.1.1
 */
import { readFileSync, writeFileSync } from 'node:fs'

const PKG = 'package.json'

const pkg = JSON.parse(readFileSync(PKG, 'utf8'))
const match = pkg.version.match(/^(\d+)\.(\d+)\.(\d+)$/)
if (!match) {
  console.error(`Unexpected version format in ${PKG}: ${pkg.version}`)
  process.exit(1)
}
const [, major, minor, patch] = match
const next = `${major}.${minor}.${Number(patch) + 1}`

pkg.version = next
writeFileSync(PKG, JSON.stringify(pkg, null, 2) + '\n')

process.stdout.write(next)
