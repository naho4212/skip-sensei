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
  // Sharded: at ~93k rules this is the one list that fails with "exceeds
  // the rule count limit" when other extensions hold part of Chrome's shared
  // static pool — seen in the field on default installs, silently. Two halves
  // let net-blocker's per-ruleset fallback enable whichever fits rather than
  // losing tracker blocking entirely.
  { adguardId: 3, id: 'trackers', name: 'AdGuard Tracking Protection', shards: ['trackers', 'trackers_2'] },
  { adguardId: 18, id: 'cookies', name: 'AdGuard Cookie Notices' },
  { adguardId: 4, id: 'social', name: 'AdGuard Social Media' },
  { adguardId: 19, id: 'popups', name: 'AdGuard Popups' },
  { adguardId: 17, id: 'url_tracking', name: 'AdGuard URL Tracking' },
]

if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true })

for (const { adguardId, id, name, shards } of RULESETS) {
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

  if (shards) {
    // Every shard carries ALL of the list's exception (allow) rules and its
    // own slice of the block rules: DNR resolves priority across enabled
    // rulesets, so a shard that loads without its sibling must still ship
    // the exceptions that keep its blocks from breaking sites.
    const isAllow = (r) => r.action.type !== 'block' && r.action.type !== 'redirect'
    const allows = kept.filter(isAllow)
    const blocks = kept.filter((r) => !isAllow(r))
    const per = Math.ceil(blocks.length / shards.length)
    shards.forEach((shardId, s) => {
      const slice = [...allows, ...blocks.slice(s * per, (s + 1) * per)].map(
        (r, i) => ({ ...r, id: i + 1 }),
      )
      if (slice.length < MIN_RULES_PER_SET)
        throw new Error(`${shardId}: only ${slice.length} rules — shard too small`)
      writeFileSync(`${OUT}/${shardId}.json`, JSON.stringify(slice))
      console.log(`${shardId}: ${slice.length} rules (shard ${s + 1}/${shards.length} of ${name})`)
    })
    continue
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

/**
 * Audio-streaming ad endpoints that AdGuard files under Tracking Protection
 * (filter 3) rather than Base. In our split that put the ONLY rules that stop
 * Spotify web-player audio ads behind the opt-in "trackers" toggle (26% of
 * install-days, and the one ruleset that fails with "exceeds the rule count
 * limit" when the static pool is contended), so a default install blocked
 * nothing on open.spotify.com — the first uninstall-survey note was exactly
 * "doesn't even work for Spotify". Shipped as its own tiny ruleset in the
 * ad-blocking group (src/net-blocker.ts AD_RULESET_IDS) so it rides the same
 * switch as every other ad list and can never be dropped by the pool limit.
 * SoundCloud / Pandora / Deezer ad endpoints are already in Base and need no
 * entry here. Patterns mirror the AdGuard Tracking Protection rules verbatim.
 */
const STREAMING_AD_FILTERS = [
  // Ad decisioning — with this blocked the web player is never handed an ad
  // to play (its `flashpoint` sub-path is the one piece Base already has).
  '||spclient.wg.spotify.com/ad-logic/',
  // The web player talks to REGIONAL spclient hosts (gew1-spclient.spotify.com,
  // guc3-spclient…), one DNS label, so a `||spclient.spotify.com` anchor never
  // matches them — the same reason AdGuard's own gabo-receiver rule is the
  // unanchored `-spclient.spotify.com/…` form. Cover ad-logic on every host.
  '-spclient.spotify.com/ad-logic/',
  '||spotify.com/ad-logic/',
  '||spotify.com/ads/',
  // Ad impression / event beacons.
  '||adeventtracker.spotify.com^',
  '||adeventtrackermonitoring.spotify.com^',
  '||aet.spotify.com^',
]
const streamingRules = STREAMING_AD_FILTERS.map((urlFilter, i) => ({
  id: i + 1,
  priority: 1,
  action: { type: 'block' },
  condition: { urlFilter },
}))
writeFileSync(`${OUT}/streaming.json`, JSON.stringify(streamingRules))
console.log(
  `streaming: ${streamingRules.length} rules (audio-streaming ad endpoints, ad-blocking group)`,
)
