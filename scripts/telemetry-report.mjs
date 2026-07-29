/**
 * Pull telemetry and summarise it.
 *
 * The extension ships one `daily_rollup` per install per day (see
 * src/telemetry-rollup.ts) plus immediate `skip_failed` /
 * `ruleset_enable_failed` alarms. Everything below aggregates ACROSS installs;
 * a single machine's numbers are an anecdote.
 *
 *   ERROR_LOG_READ_KEY=… node scripts/telemetry-report.mjs [--days 14] [--json]
 *
 * The key is an Encrypted Vercel env var that `vercel env pull` returns empty,
 * so it has to be passed in. Never commit it.
 */
const HOSTS = [
  'https://landing-beta-three-23.vercel.app',
  'https://www.singlefinmedia.com/ad-sensei',
]

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? fallback : args[i + 1]
}
const DAYS = Number(flag('days', 14))
const AS_JSON = args.includes('--json')

const KEY = process.env.ERROR_LOG_READ_KEY
if (!KEY) {
  console.error(
    'Set ERROR_LOG_READ_KEY (Vercel → singlefin/landing → Settings → Environment Variables).',
  )
  process.exit(1)
}

async function fetchEvents() {
  let lastError
  for (const host of HOSTS) {
    const url = `${host}/api/errors?type=events&key=${encodeURIComponent(KEY)}&limit=1000`
    try {
      const res = await fetch(url)
      if (!res.ok) {
        lastError = `${host} → HTTP ${res.status}`
        continue
      }
      const body = await res.json()
      const items = Array.isArray(body)
        ? body
        : (body.reports ?? body.events ?? body.items ?? body.errors ?? [])
      return { host, items }
    } catch (error) {
      lastError = `${host} → ${error.message}`
    }
  }
  throw new Error(`could not read telemetry (${lastError})`)
}

const num = (v) => (v === undefined || v === '' ? 0 : Number(v) || 0)
const sum = (list, pick) => list.reduce((acc, x) => acc + num(pick(x)), 0)

/**
 * Percentile of a per-install percentile is not a percentile — but averaging
 * p50s weighted by sample size is a defensible summary and far better than
 * pretending we have the raw distribution back. Flagged as approximate in the
 * output so nobody quotes it as exact.
 */
function weighted(rollups, valueKey, weightKey = 'skips') {
  const usable = rollups.filter((r) => num(r.fields?.[weightKey]) > 0)
  const w = sum(usable, (r) => r.fields[weightKey])
  if (!w) return null
  return (
    usable.reduce(
      (acc, r) => acc + num(r.fields[valueKey]) * num(r.fields[weightKey]),
      0,
    ) / w
  )
}

const pctShare = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—')

function report({ host, items }) {
  const since = Date.now() - DAYS * 86400_000
  const recent = items.filter((e) => {
    const t = Date.parse(e.timestamp ?? e.received_at ?? e.at ?? 0)
    return Number.isFinite(t) ? t >= since : true
  })
  const rollups = recent.filter((e) => e.kind === 'daily_rollup')
  const installs = new Set(rollups.map((r) => r.install_id)).size
  const versions = [...new Set(rollups.map((r) => r.app_version))].sort()

  if (AS_JSON) {
    console.log(JSON.stringify({ host, days: DAYS, installs, rollups }, null, 2))
    return
  }

  console.log(`source ${host} · last ${DAYS} days`)
  console.log(
    `${rollups.length} daily rollups from ${installs} install(s) · versions ${versions.join(', ') || '—'}\n`,
  )
  if (rollups.length === 0) {
    console.log('No rollups yet. They only come from v0.3.11+ installs, once a')
    console.log('day, and only when telemetry is on. Other event kinds seen:')
    const kinds = {}
    for (const e of recent) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1
    for (const [k, n] of Object.entries(kinds).sort((a, b) => b[1] - a[1]))
      console.log(`   ${n.toString().padStart(5)}  ${k}`)
    return
  }

  const skips = sum(rollups, (r) => r.fields.skips)
  const over5 = sum(rollups, (r) => r.fields.skip_over5s)
  const p50 = weighted(rollups, 'skip_p50')
  const p90 = weighted(rollups, 'skip_p90')
  const worst = Math.max(...rollups.map((r) => num(r.fields.skip_max)))

  console.log('SKIP LATENCY  (the number that decides first-party pruning)')
  console.log(`   skips measured      ${skips}`)
  console.log(`   p50 (approx, weighted) ${p50 === null ? '—' : p50.toFixed(1) + 's'}`)
  console.log(`   p90 (approx, weighted) ${p90 === null ? '—' : p90.toFixed(1) + 's'}`)
  console.log(`   worst seen          ${worst ? worst.toFixed(1) + 's' : '—'}`)
  console.log(`   over 5s             ${over5} (${pctShare(over5, skips)})`)

  // Per-method medians travel as m_<method>_p50 / _n.
  const methodKeys = new Set()
  for (const r of rollups)
    for (const k of Object.keys(r.fields ?? {}))
      if (k.startsWith('m_') && k.endsWith('_n')) methodKeys.add(k.slice(2, -2))
  for (const m of methodKeys) {
    const n = sum(rollups, (r) => r.fields[`m_${m}_n`])
    const med = weighted(rollups, `m_${m}_p50`, `m_${m}_n`)
    console.log(
      `   · ${m.padEnd(14)} ${String(n).padStart(5)} skips, median ${med === null ? '—' : med.toFixed(1) + 's'}`,
    )
  }

  const walls = sum(rollups, (r) => r.fields.walls)
  const trips = sum(rollups, (r) => r.fields.breaker_trips)
  const tried = sum(rollups, (r) => r.fields.clear_visitor_tried)
  const failed = sum(rollups, (r) => r.fields.clear_visitor_failed)
  const full = sum(rollups, (r) => r.fields.clear_full)
  console.log('\nENFORCEMENT WALLS')
  console.log(`   walls               ${walls}  (${(walls / rollups.length).toFixed(1)} per install-day)`)
  console.log(`   breaker trips       ${trips}`)
  console.log(`   visitor-only clears ${tried} tried, ${failed} still walled → worked ${tried - failed} (${pctShare(tried - failed, tried)})`)
  console.log(`   full wipes          ${full}`)

  const fails = sum(rollups, (r) => r.fields.skip_failures)
  console.log('\nHEALTH  (rising numbers here mean the product is degrading)')
  console.log(`   skip failures       ${fails} (${pctShare(fails, fails + skips)} of breaks)`)
  console.log(`   self-heals          ${sum(rollups, (r) => r.fields.self_heals)}`)
  console.log(`   cosmetic un-hides   ${sum(rollups, (r) => r.fields.cosmetic_unhides)}`)
  console.log(`   ruleset enable fails ${sum(rollups, (r) => r.fields.ruleset_fails)}`)

  console.log('\nADOPTION  (share of install-days with the feature on)')
  const FEATURES = {
    f_ads: 'skip YouTube ads',
    f_sponsor: 'sponsor skipping',
    f_pruning: 'first-party pruning',
    f_web: 'web ad blocking',
    f_trackers: 'tracker blocking',
    f_resume: 'resume position',
    f_ai: 'AI enhancements',
  }
  for (const [key, label] of Object.entries(FEATURES)) {
    const on = rollups.filter((r) => r.fields?.[key] === '1').length
    console.log(`   ${label.padEnd(20)} ${pctShare(on, rollups.length)}`)
  }

  const alarms = recent.filter(
    (e) => e.kind === 'skip_failed' || e.kind === 'ruleset_enable_failed',
  )
  if (alarms.length) {
    console.log(`\nIMMEDIATE ALARMS (${alarms.length})`)
    const byReason = {}
    for (const a of alarms) {
      const k = `${a.kind}:${a.fields?.reason ?? a.fields?.ruleset ?? '?'}`
      byReason[k] = (byReason[k] ?? 0) + 1
    }
    for (const [k, n] of Object.entries(byReason).sort((a, b) => b[1] - a[1]))
      console.log(`   ${String(n).padStart(4)}  ${k}`)
  }
}

report(await fetchEvents())
