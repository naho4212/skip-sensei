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

/**
 * Static-rule priority ceiling, ENFORCED below. The runtime exemption rules
 * (the yt_exempt ruleset written here, and the dynamic allowlist rule in
 * src/net-blocker.ts — EXEMPT_PRIORITY there) sit at 100,000,000 and MUST
 * out-prioritize every block rule we ship: DNR resolves by priority first,
 * and action precedence (allow > block) only breaks ties. AdGuard's converter
 * encodes $important as +1,000,000 (observed max 1,100,201), which is exactly
 * how the old 1,000,000-priority exemption silently lost to
 * `||youtube.com/get_video_info?*=adunit&` at 1,000,001. If AdGuard ever
 * raises its scheme past this ceiling, the build FAILS here instead of
 * shipping an exemption that can be out-prioritized.
 */
const STATIC_PRIORITY_CEILING = 10_000_000
/** Keep identical with EXEMPT_PRIORITY / ALLOWLIST_PRIORITY in src/net-blocker.ts. */
const EXEMPT_PRIORITY = 100_000_000

/** A truncated/empty AdGuard source file must fail the build, not ship a
 * near-empty ruleset with a green exit code. Every current list is well above
 * this floor (smallest: social at ~600). */
const MIN_RULES_PER_SET = 100

/**
 * Domains that must NEVER be network-blocked (enforcement-wall trigger).
 * Keep identical with NETWORK_EXEMPT in src/net-blocker.ts. Shipped as a
 * one-rule STATIC ruleset enabled in the manifest, so the exemption exists
 * from install time with no runtime ordering, no dynamic-rule race, and no
 * failure mode — the dynamic allowlist rule is then belt-and-braces for
 * these domains and the carrier for the user's own allowlist.
 */
const NETWORK_EXEMPT = ['youtube.com', 'youtube-nocookie.com', 'googlevideo.com']

/**
 * Which rules to keep. block/allow need no host permissions and no resource
 * files. redirect rules are kept ONLY when self-contained — i.e. they strip
 * query params via `transform` (the URL Tracking list) rather than pointing at
 * an AdGuard redirect-resource file we don't bundle. modifyHeaders/resource
 * redirects are dropped.
 */
function keepRule(r) {
  const t = r?.action?.type
  if (t === 'block' || t === 'allow' || t === 'allowAllRequests') return true
  if (t === 'redirect' && r.action.redirect?.transform) return true
  return false
}

// AdGuard filter id → our ruleset id (see filters_i18n.json for names).
const RULESETS = [
  { adguardId: 2, id: 'ads_base', name: 'AdGuard Base (EasyList-equivalent)' },
  { adguardId: 11, id: 'ads_mobile', name: 'AdGuard Mobile Ads' },
  { adguardId: 3, id: 'trackers', name: 'AdGuard Tracking Protection' },
  { adguardId: 18, id: 'cookies', name: 'AdGuard Cookie Notices' },
  { adguardId: 4, id: 'social', name: 'AdGuard Social Media' },
  { adguardId: 19, id: 'popups', name: 'AdGuard Popups' },
  { adguardId: 17, id: 'url_tracking', name: 'AdGuard URL Tracking' },
]

if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true })

for (const { adguardId, id, name } of RULESETS) {
  const path = `${SRC}/ruleset_${adguardId}/ruleset_${adguardId}.json`
  const rules = JSON.parse(readFileSync(path, 'utf8'))
  const kept = rules
    .filter(keepRule)
    // Keep ONLY valid DNR rule keys — AdGuard embeds a large `metadata` blob
    // on the first rule that isn't a valid property and bloats the file.
    .map((r, i) => {
      const rule = { id: i + 1, action: r.action, condition: r.condition }
      if (typeof r.priority === 'number') rule.priority = r.priority
      return rule
    })

  // Invariant gates — fail the BUILD rather than ship a broken artifact.
  if (kept.length < MIN_RULES_PER_SET) {
    throw new Error(
      `${id}: only ${kept.length} rules kept — source file truncated or format changed`,
    )
  }
  const overCeiling = kept.filter(
    (r) => (r.priority ?? 1) >= STATIC_PRIORITY_CEILING,
  )
  if (overCeiling.length > 0) {
    throw new Error(
      `${id}: ${overCeiling.length} rule(s) at priority >= ${STATIC_PRIORITY_CEILING} ` +
        `(max ${Math.max(...overCeiling.map((r) => r.priority))}) — these would ` +
        `out-prioritize the YouTube/allowlist exemption. Raise EXEMPT_PRIORITY ` +
        `(both here and in src/net-blocker.ts) above the new AdGuard ceiling first.`,
    )
  }

  writeFileSync(`${OUT}/${id}.json`, JSON.stringify(kept))
  console.log(
    `${id}: ${kept.length} rules kept of ${rules.length} (${name})`,
  )
}

// The always-on exemption ruleset (see NETWORK_EXEMPT above): one
// allowAllRequests rule covering YouTube's page + embed frames, enabled in
// the manifest so it is live from install time.
const exemptRules = [
  {
    id: 1,
    priority: EXEMPT_PRIORITY,
    action: { type: 'allowAllRequests' },
    condition: {
      requestDomains: NETWORK_EXEMPT,
      resourceTypes: ['main_frame', 'sub_frame'],
    },
  },
]
writeFileSync(`${OUT}/yt_exempt.json`, JSON.stringify(exemptRules))
console.log(
  `yt_exempt: ${exemptRules.length} rule (always-on YouTube exemption, priority ${EXEMPT_PRIORITY})`,
)
