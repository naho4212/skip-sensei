import { reportEvent } from './error-reporting'
import {
  bumpDailyCounter,
  drainDailyCounters,
  getDailyCounters,
  getSettings,
  getSkipTimings,
  restoreDailyCounters,
  type SkipTiming,
} from './storage'

/**
 * One aggregate telemetry event per install per day.
 *
 * Per-event pings can't answer the questions this product actually needs
 * answered. `reportEvent` caps at 20/hour and suppresses events whose field
 * values repeat within the hour, so the common outcomes — the ones that define
 * a distribution — collapse into a single sample while oddities get through.
 * Percentiles built from that are not just noisy, they're biased.
 *
 * Aggregating on-device fixes it and is the better privacy story too: the
 * server learns the shape of the day, not a timestamped trace of when someone
 * watched what. Alarms are immune to service-worker dormancy, which a
 * setInterval would not be.
 *
 * Distributions ride this rollup. Alarms — a product that has stopped working
 * — do NOT wait for it: skip failures and ruleset-enable failures also fire
 * immediately, because a day's delay on "ad blocking is broken" is a day too
 * long.
 */

const ALARM_NAME = 'skipSensei.dailyRollup'
const PERIOD_MINUTES = 24 * 60
const LAST_SENT_KEY = 'skipSensei.rollupLastSent'

/** Percentile from a sorted array, nearest-rank. */
function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const i = Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))
  return sorted[i]
}

const r1 = (n: number) => Math.round(n * 10) / 10

/** Percentiles rather than a mean: skip time is long-tailed, and a mean hides
 * exactly the slow cases a user notices and complains about. */
function skipStats(timings: SkipTiming[]): Record<string, string> {
  if (timings.length === 0) return { skips: '0' }
  const all = timings.map((t) => t.s).sort((a, b) => a - b)
  const fields: Record<string, string> = {
    skips: String(all.length),
    skip_p50: String(r1(pct(all, 50))),
    skip_p90: String(r1(pct(all, 90))),
    skip_max: String(r1(all[all.length - 1])),
    skip_over5s: String(all.filter((s) => s > 5).length),
  }
  // Per-method medians are diagnostic on their own: a slow "skip button"
  // median means YouTube is gating the button, a slow "fast-forward" means
  // seeks are being reset. Different problems, different fixes.
  const byMethod = new Map<string, number[]>()
  for (const t of timings) {
    const list = byMethod.get(t.m) ?? []
    list.push(t.s)
    byMethod.set(t.m, list)
  }
  for (const [method, list] of byMethod) {
    const key = method.replace(/[^a-z]+/gi, '_').toLowerCase().slice(0, 20)
    const sorted = list.sort((a, b) => a - b)
    fields[`m_${key}_n`] = String(sorted.length)
    fields[`m_${key}_p50`] = String(r1(pct(sorted, 50)))
  }
  return fields
}

/**
 * Which capabilities are switched on. Coarse booleans only — enough to know
 * whether anyone uses first-party pruning before investing more in it, with
 * nothing that identifies a person or what they watched.
 */
function adoption(s: Awaited<ReturnType<typeof getSettings>>) {
  const b = (v: boolean) => (v ? '1' : '0')
  return {
    f_ads: b(s.adEngineEnabled),
    f_sponsor: b(s.sponsorEngineEnabled),
    f_pruning: b(s.aggressivePruning),
    f_web: b(s.blockAllAds),
    f_trackers: b(s.blockTrackers),
    f_resume: b(s.resumePlayback),
    f_ai: b(s.aiEnhancements),
  }
}

export async function sendDailyRollup(): Promise<boolean> {
  const settings = await getSettings()
  // reportEvent enforces the same gate, but returning early keeps us from
  // draining the local counters for a send that never leaves the machine.
  if (!settings.telemetryEnabled || settings.localOnlyMode) return false

  // Atomic take-and-reset on the counter chain: a bump landing while the
  // rollup is on the wire queues behind the drain and counts toward the NEXT
  // rollup, instead of being wiped by an unchained reset afterwards.
  const { day, counts } = await drainDailyCounters()
  const timings = await getSkipTimings()
  // Same local-date basis as the counters, so the stats and the counts in one
  // rollup describe the same 24 hours.
  const localDay = (ms: number) => {
    const d = new Date(ms)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  }
  const dayTimings = timings.filter((t) => localDay(t.at) === day)

  const fields: Record<string, string> = {
    // The date makes every rollup unique, so reportEvent's same-values dedupe
    // can never swallow one — the exact trap that made the per-event data
    // unusable.
    day,
    ...skipStats(dayTimings),
    ...adoption(settings),
    walls: String(counts.walls ?? 0),
    breaker_trips: String(counts.breakerTrips ?? 0),
    skip_failures: String(counts.skipFailures ?? 0),
    self_heals: String(counts.selfHeals ?? 0),
    cosmetic_unhides: String(counts.cosmeticUnhides ?? 0),
    ruleset_fails: String(counts.rulesetEnableFailures ?? 0),
    // The open question: does the visitor-only clear ever actually lift a
    // wall? Two counters answer it across the whole install base instead of
    // from one person's anecdote.
    clear_visitor_tried: String(counts.visitorClearTried ?? 0),
    clear_visitor_failed: String(counts.visitorClearFailed ?? 0),
    clear_full: String(counts.fullClears ?? 0),
  }

  const attempted = await reportEvent('daily_rollup', fields)
  if (attempted) {
    await chrome.storage.local.set({ [LAST_SENT_KEY]: day })
  } else {
    // The shared 20-events/hour budget dropped it locally. Put the drained
    // counts back and DON'T mark the day sent — a later wake retries once the
    // budget window rolls, instead of silently losing the whole day.
    await restoreDailyCounters({ day, counts })
  }
  return attempted
}

/**
 * Send if a rollup hasn't gone out for the current day yet.
 *
 * Serialized: on an alarm-wake of a dormant worker, BOTH the init-time check
 * and the delivered alarm event call this, and unserialized they both read
 * LAST_SENT_KEY before either wrote it — two rollups, the second with
 * freshly-drained (zeroed) counters, inflating install-day counts in the
 * report. On the chain, the second caller sees the first's write and no-ops.
 */
let rollupChain: Promise<void> = Promise.resolve()

function maybeSend(): Promise<void> {
  rollupChain = rollupChain
    .then(async () => {
      const { day } = await getDailyCounters()
      const last = (await chrome.storage.local.get(LAST_SENT_KEY))[
        LAST_SENT_KEY
      ]
      if (last === day) return
      await sendDailyRollup()
    })
    .catch(() => {})
  return rollupChain
}

export function initTelemetryRollup(): void {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_NAME) void maybeSend()
  })
  // Create only if missing: alarms persist across service-worker restarts,
  // and re-creating one RESETS its timer to a full period from now — on an
  // active browser (frequent SW wakes) the alarm would simply never fire.
  void chrome.alarms.get(ALARM_NAME).then((existing) => {
    if (!existing)
      chrome.alarms.create(ALARM_NAME, { periodInMinutes: PERIOD_MINUTES })
  })
  // A browser that's only open in short bursts may never see the alarm fire,
  // so also check on startup — maybeSend is idempotent per day.
  void maybeSend()
}

/**
 * Failures that must not wait for the daily rollup: these mean the product has
 * stopped doing its job for that user right now. Still counted for the rollup
 * (the rate matters), but also sent immediately (the fact matters sooner).
 */
export async function reportImmediateFailure(
  kind: 'skip_failed' | 'ruleset_enable_failed',
  fields: Record<string, string>,
): Promise<void> {
  await bumpDailyCounter(
    kind === 'skip_failed' ? 'skipFailures' : 'rulesetEnableFailures',
  )
  void reportEvent(kind, fields)
}
