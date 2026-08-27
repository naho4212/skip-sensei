/**
 * Render landing/release-notes.html from src/changelog.ts (the single source
 * of truth for user-facing release notes — the popup's "What's new" banner
 * reads the same array). Runs as part of `npm run package` so the page can
 * never drift from the shipped changelog; the landing prod deploy publishes it
 * at https://www.singlefinmedia.com/ad-sensei/release-notes.
 *
 * The changelog is a plain literal array, so it's extracted textually and
 * evaluated — no TS toolchain needed here.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const src = readFileSync(new URL('../src/changelog.ts', import.meta.url), 'utf8')
const m = src.match(/CHANGELOG: ChangelogEntry\[\] = (\[[\s\S]*?\n\])/)
if (!m) throw new Error('CHANGELOG array not found in src/changelog.ts')
const entries = new Function(`return ${m[1]}`)()
if (!Array.isArray(entries) || entries.length === 0)
  throw new Error('CHANGELOG parsed empty')

const esc = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * Category per item: Improvements (blocking/skipping got better), Features
 * (new UI/capability), Bug fixes. Forward convention: start an item with
 * "Fixed:" and it lands in Bug fixes; otherwise the heuristic decides, and
 * OVERRIDES pins the existing items it would misread (stat-accuracy items
 * read as protection, AI-accuracy items read as features, and so on).
 */
const CATS = { protect: 'Improvements', feat: 'Features', fix: 'Bug fixes' }
const OVERRIDES = [
  ['Tracker blocking ships in two parts', 'protect'],
  ['Ad-blocker warning dialogs on YouTube are recorded', 'fix'],
  ['The AI now reads a popup', 'protect'],
  ['YouTube “playback blocked” recovery panel, take two', 'fix'],
  ['Ad-hiding rules now refresh automatically', 'protect'],
  ['Added a re-analyze button', 'feat'],
  ['Clearer first-run note', 'feat'],
  ['Resetting feature settings no longer', 'fix'],
  ['Paused-sites entries are checked', 'fix'],
  ['Aggressive mode’s ad count now reflects', 'fix'],
  ['Recovers automatically if the player', 'protect'],
  ['The AI now audits what the filter lists hide', 'protect'],
  ['Hidden YouTube display ads now count', 'fix'],
  ['More honest YouTube ad count', 'fix'],
  ['YouTube ad count now reflects what you actually watched', 'fix'],
  ['Honest ad counting', 'fix'],
  ['One ad now counts as one', 'fix'],
  ['The per-page “blocked here” count is now accurate', 'fix'],
  ['Polished the welcome page', 'feat'],
]
function classify(t) {
  for (const [prefix, cat] of OVERRIDES) if (t.startsWith(prefix)) return cat
  const tl = t.toLowerCase()
  if (/^fixed\b|^fix\b/.test(tl) || tl.includes('crash')) return 'fix'
  if (
    /welcome page|onboarding|support page|release notes|rating|review|share|settings|options page|dark mode|stats|counter|badge|activity|log|popup now|new tab|design|language/.test(tl)
  )
    return 'feat'
  if (/skip|block|mute|hidden|hide|tracker|malware|cookie|anti-adblock|wall|filter|prune|ads\b|ad-|sponsor|popup/.test(tl))
    return 'protect'
  return 'feat'
}

const months = ['January','February','March','April','May','June','July','August','September','October','November','December']
const fmtDate = (iso) => {
  const [y, mo, d] = iso.split('-').map(Number)
  return `${months[mo - 1]} ${d}, ${y}`
}

const CANON = 'https://www.singlefinmedia.com/ad-sensei'

/**
 * Only Chrome-Web-Store-published versions get a section (users only ever
 * receive those); dev-only versions in between roll their items into the
 * next published release. Everything before the FIRST store release folds
 * into a collapsed "leading up to" block on that entry.
 */
const chrono = [...entries].reverse() // oldest → newest
const releases = []
let carry = []
let carryLastVersion = null
for (const e of chrono) {
  if (!e.published) {
    carry.push(...e.items)
    carryLastVersion = e.version
    continue
  }
  releases.push({
    version: e.version,
    date: e.date,
    items: [...carry, ...e.items],
    first: releases.length === 0,
    preSpan: releases.length === 0 && carry.length > 0
      ? `v${chrono[0].version} – v${carryLastVersion}`
      : null,
    preItems: releases.length === 0 ? carry : [],
  })
  carry = []
}
if (releases.length === 0) throw new Error('no published releases in CHANGELOG')
if (carry.length > 0)
  console.warn(`release-notes: ${carry.length} item(s) newer than the last published release are held back`)
// First release: its own items only; the pre-history goes in the details block.
releases[0].items = releases[0].items.slice(releases[0].preItems.length)
releases.reverse() // newest first for display

const sections = releases
  .map((e) => {
    const grouped = (items, indent = '        ') => {
      const groups = { protect: [], feat: [], fix: [] }
      for (const item of items) groups[classify(item)].push(item)
      return Object.entries(CATS)
        .filter(([k]) => groups[k].length > 0)
        .map(
          ([k, label]) => `${indent}<h3 class="cat cat-${k}">${label}</h3>
${indent}<ul>
${groups[k].map((i) => `${indent}  <li>${esc(i)}</li>`).join('\n')}
${indent}</ul>`,
        )
        .join('\n')
    }
    const pre = e.preItems.length
      ? `\n        <details class="pre">
          <summary>Everything leading up to the first release (${esc(e.preSpan)})</summary>
${grouped(e.preItems, '          ')}
        </details>`
      : ''
    const firstTag = e.first ? ' <span class="first-tag">First Chrome Web Store release</span>' : ''
    return `      <section class="release" id="v${esc(e.version)}">
        <h2>v${esc(e.version)} <span class="date">${fmtDate(e.date)}</span>${firstTag}</h2>
${grouped(e.items)}${pre}
      </section>`
  })
  .join('\n')

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Ad Sensei — Release Notes</title>
    <meta name="description" content="What's new in each Ad Sensei release — the full changelog for the AI ad blocker for every site and YouTube." />
    <meta name="robots" content="index,follow" />
    <link rel="canonical" href="${CANON}/release-notes" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="Ad Sensei" />
    <meta property="og:title" content="Ad Sensei — Release Notes" />
    <meta property="og:description" content="What's new in each Ad Sensei release." />
    <meta property="og:url" content="${CANON}/release-notes" />
    <meta property="og:image" content="${CANON}/og.png" />
    <link rel="icon" href="${CANON}/icon.png" />
    <style>
      :root { color-scheme: light dark; --accent: #7c3aed; --accent-bright: #8b5cf6; }
      body {
        font-family: -apple-system, Roboto, Arial, sans-serif;
        line-height: 1.6; color: #1a1a1a; background: #fff;
        max-width: 760px; margin: 0 auto; padding: 48px 24px 96px;
      }
      @media (prefers-color-scheme: dark) { body { color: #e8e8e8; background: #111; } }
      .lockup { display: flex; align-items: center; gap: 10px; margin-bottom: 36px; text-decoration: none; color: inherit; }
      .lockup .mark { width: 34px; height: 34px; border-radius: 9px; background: var(--accent); display: grid; place-items: center; }
      .lockup .mark svg { width: 20px; height: 14px; fill: #fff; }
      .lockup b { font-size: 17px; }
      .lockup b span { color: var(--accent-bright); }
      h1 { font-size: 28px; letter-spacing: -0.02em; margin: 0 0 6px; }
      p.lede { margin: 0 0 40px; opacity: 0.75; }
      .release { padding: 4px 0 8px; }
      .release + .release { border-top: 1px solid rgba(128,128,128,0.25); padding-top: 24px; }
      .release h2 { font-size: 18px; margin: 0 0 10px; }
      .release .date { font-size: 13px; font-weight: 400; opacity: 0.6; margin-left: 8px; }
      .release h3.cat {
        font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;
        margin: 14px 0 4px; display: flex; align-items: center; gap: 7px;
      }
      .release h3.cat::before { content: ''; width: 7px; height: 7px; border-radius: 50%; }
      .cat-protect { color: #8b5cf6; } .cat-protect::before { background: #8b5cf6; }
      .cat-feat { color: #3ea6ff; } .cat-feat::before { background: #3ea6ff; }
      .cat-fix { color: #4ade80; } .cat-fix::before { background: #4ade80; }
      @media (prefers-color-scheme: light) {
        .cat-protect { color: #6d28d9; } .cat-feat { color: #065fd4; } .cat-fix { color: #15803d; }
      }
      .release ul { margin: 0 0 4px; padding-left: 20px; }
      .first-tag {
        font-size: 11px; font-weight: 600; letter-spacing: 0.03em;
        color: var(--accent-bright); border: 1px solid var(--accent-bright);
        border-radius: 999px; padding: 2px 9px; margin-left: 10px; vertical-align: 2px;
      }
      details.pre { margin-top: 16px; }
      details.pre summary { cursor: pointer; font-size: 13.5px; opacity: 0.75; }
      details.pre summary:hover { opacity: 1; }
      details.pre[open] summary { margin-bottom: 4px; }
      .release li { margin: 6px 0; font-size: 14.5px; }
      footer { margin-top: 64px; font-size: 13px; opacity: 0.75; }
      footer a { color: inherit; }
    </style>
  </head>
  <body>
    <a class="lockup" href="${CANON}">
      <span class="mark"><svg viewBox="0 0 24 17"><path d="M0 1.5l6 7-6 7v-14zm7.5 0l6 7-6 7v-14zm8.5 0h2.4v14H16v-14z"/></svg></span>
      <b>Ad<span>Sensei</span></b>
    </a>
    <h1>Release notes</h1>
    <p class="lede">Every user-facing change, newest first. The extension updates automatically from the Chrome&nbsp;Web&nbsp;Store.</p>
${sections}
    <footer>
      <a href="${CANON}">Ad Sensei</a> · <a href="${CANON}/privacy">Privacy Policy</a> ·
      <a href="${CANON}/terms">Terms of Service</a> · <a href="${CANON}/support">Support</a>
    </footer>
  </body>
</html>
`
writeFileSync(new URL('../landing/release-notes.html', import.meta.url), html)
console.log(`release-notes: ${releases.length} published release(s) (latest v${releases[0].version}), ${entries.length} changelog versions total`)
