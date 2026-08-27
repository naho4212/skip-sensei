// Ad Sensei operational-event collector (Vercel serverless function).
//
// Sibling of /api/error, for non-error signals that guide improvements —
// chiefly self-heals ("YouTube renamed the skip button; the AI healed to
// selector X"). Whitelists + caps every field and persists one JSON blob per
// event under events/<day>/<ts>.json. Read back via
// GET /api/errors?type=events&key=<ERROR_LOG_READ_KEY>.
//
// Same privacy posture as /api/error: the extension only sends these when the
// user's telemetry setting is on, and values are scrubbed before they leave
// the browser. Payloads carry CSS selectors / event kinds, never anything
// personal.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const VERSION_RE = /^[\w.-]{1,32}$/

/** Top-level field → max length. `fields` is handled separately. */
const TEXT_FIELDS = {
  kind: 40,
  provider: 16,
  browser: 40,
}

// 48, not the original 12: the extension's `daily_rollup` carries ~25-35
// fields (skip percentiles, per-method medians, 7 adoption flags, ~11 health
// counters, 6+ ui_* usage counters). At 12 the loop below silently kept the
// first dozen in insertion order and dropped the rest — every HEALTH number
// and every ui_* counter in scripts/telemetry-report.mjs read as a hard 0 for
// a month while the data was being sent fine. Per-field size caps still bound
// the record; the count cap only needs to defeat junk payloads.
const MAX_FIELDS = 48
const MAX_FIELD_KEY = 40
const MAX_FIELD_VALUE = 300
// The support form's message body is the one field that legitimately runs
// long (kind: "contact", also uninstall-survey notes); everything else stays
// at the tight default.
const FIELD_VALUE_OVERRIDES = { message: 2000 }

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'content-type')
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).end()

  const body = req.body ?? {}
  const installId = String(body.install_id ?? '')
  const version = String(body.app_version ?? '')
  if (
    body.event !== 'app_event' ||
    !UUID_RE.test(installId) ||
    !VERSION_RE.test(version)
  ) {
    return res.status(400).end()
  }

  const record = {
    event: 'app_event',
    install_id: installId,
    app_version: version,
    received_at: new Date().toISOString(),
  }
  for (const [field, max] of Object.entries(TEXT_FIELDS)) {
    if (typeof body[field] === 'string' && body[field]) {
      record[field] = body[field].slice(0, max)
    }
  }
  // Nested `fields` map (string → string), capped in count and size.
  if (body.fields && typeof body.fields === 'object') {
    const fields = {}
    let n = 0
    for (const [key, value] of Object.entries(body.fields)) {
      if (n >= MAX_FIELDS) break
      if (typeof value !== 'string' || !value) continue
      const cap = FIELD_VALUE_OVERRIDES[key] ?? MAX_FIELD_VALUE
      fields[String(key).slice(0, MAX_FIELD_KEY)] = value.slice(0, cap)
      n++
    }
    record.fields = fields
  }

  const line = JSON.stringify(record)
  console.log('[app-event]', line)

  try {
    const { put } = await import('@vercel/blob')
    const stamp = record.received_at.replace(/[:.]/g, '-')
    await put(`events/${stamp.slice(0, 10)}/${stamp}.json`, line, {
      access: 'public',
      contentType: 'application/json',
      addRandomSuffix: true,
    })
  } catch (err) {
    console.log('[app-event] blob write failed:', err && err.message)
  }

  return res.status(204).end()
}
