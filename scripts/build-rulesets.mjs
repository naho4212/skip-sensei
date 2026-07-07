/**
 * Build lean, block-only DNR rulesets for the "Block all ads" engine from the
 * AdGuard prebuilt MV3 rulesets (EasyList-derived). Re-run to refresh filters:
 *   npm i -D @adguard/dnr-rulesets@latest && node scripts/build-rulesets.mjs
 *
 * We keep only block/allow-type rules and drop redirect/modifyHeaders, because:
 *  - redirect rules reference AdGuard redirect-resource files we don't bundle
 *    (they'd error on load), and
 *  - block/allow rules require NO host permissions, so the whole feature ships
 *    on just the `declarativeNetRequest` permission.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'

const SRC =
  'node_modules/@adguard/dnr-rulesets/dist/filters/chromium-mv3/declarative'
const OUT = 'public/rulesets'
const KEEP_ACTIONS = new Set(['block', 'allow', 'allowAllRequests'])

// AdGuard filter id → our ruleset id (see filters_i18n.json for names).
const RULESETS = [
  { adguardId: 2, id: 'ads_base', name: 'AdGuard Base (EasyList-equivalent)' },
  { adguardId: 11, id: 'ads_mobile', name: 'AdGuard Mobile Ads' },
]

if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true })

for (const { adguardId, id, name } of RULESETS) {
  const path = `${SRC}/ruleset_${adguardId}/ruleset_${adguardId}.json`
  const rules = JSON.parse(readFileSync(path, 'utf8'))
  const kept = rules
    .filter((r) => KEEP_ACTIONS.has(r?.action?.type))
    // Keep ONLY valid DNR rule keys — AdGuard embeds a large `metadata` blob
    // on the first rule that isn't a valid property and bloats the file.
    .map((r, i) => {
      const rule = { id: i + 1, action: r.action, condition: r.condition }
      if (typeof r.priority === 'number') rule.priority = r.priority
      return rule
    })
  writeFileSync(`${OUT}/${id}.json`, JSON.stringify(kept))
  console.log(
    `${id}: ${kept.length} rules kept of ${rules.length} (${name})`,
  )
}
