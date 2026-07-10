/**
 * Emit a small `{ rulesetId: ruleCount }` manifest so the options page can show
 * per-ruleset rule counts without fetching and parsing the (large) ruleset
 * files at runtime. Runs LAST in `npm run rulesets`, after build-rulesets.mjs
 * and build-malware-ruleset.mjs have written every `public/rulesets/*.json`.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'

const DIR = 'public/rulesets'
const OUT = `${DIR}/_counts.json`

const counts = {}
for (const file of readdirSync(DIR)) {
  if (!file.endsWith('.json') || file.startsWith('_')) continue
  const id = file.replace(/\.json$/, '')
  const rules = JSON.parse(readFileSync(`${DIR}/${file}`, 'utf8'))
  counts[id] = Array.isArray(rules) ? rules.length : 0
}

writeFileSync(OUT, JSON.stringify(counts))
const total = Object.values(counts).reduce((a, b) => a + b, 0)
console.log(
  `ruleset counts: ${Object.keys(counts).length} rulesets, ${total.toLocaleString()} rules total`,
)
