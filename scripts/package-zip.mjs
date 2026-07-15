// Package .output/chrome-mv3/ into the landing page's download zip, versioned
// by the extension version: landing/ad-sensei-v<version>.zip. Also rewrites
// the landing CTA links to point at the new filename and removes stale zips.
//
// Run via `npm run package` (which builds first).

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const dist = path.join(root, '.output', 'chrome-mv3')
const landing = path.join(root, 'landing')

const manifest = JSON.parse(
  fs.readFileSync(path.join(dist, 'manifest.json'), 'utf8'),
)
const zipName = `ad-sensei-v${manifest.version}.zip`

// Drop any previous download zips (versioned or not) so exactly one ships.
for (const file of fs.readdirSync(landing)) {
  if (/^ad-sensei(-v[\w.-]+)?\.zip$/.test(file)) {
    fs.rmSync(path.join(landing, file))
  }
}

// Exclude _metadata: Chrome writes content-verification hashes into a loaded
// unpacked dir (e.g. after a CDP test run loaded .output directly), and Chrome
// REFUSES to load an unpacked extension that contains a _metadata folder — a
// zip shipping it would be broken for every new user.
execFileSync(
  'zip',
  ['-qr', path.join(landing, zipName), '.', '-x', '.*', '-x', '_metadata/*'],
  { cwd: dist },
)

// Point every CTA at the new filename.
const indexPath = path.join(landing, 'index.html')
const html = fs.readFileSync(indexPath, 'utf8')
const updated = html.replace(/ad-sensei(-v[\w.-]+)?\.zip/g, zipName)
fs.writeFileSync(indexPath, updated)

const bytes = fs.statSync(path.join(landing, zipName)).size
console.log(
  `landing/${zipName} (${(bytes / 1_048_576).toFixed(1)} MB), ` +
    `${(html.match(/ad-sensei(-v[\w.-]+)?\.zip/g) ?? []).length} CTA link(s) updated`,
)
