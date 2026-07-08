// Ad Sensei error-report collector (Vercel serverless function).
//
// Accepts POST app_error events from the extension, whitelists and caps every
// field, and writes one JSON line to the function log. View with
// `vercel logs` or the Vercel dashboard.
//
// NOTE: function logs are short-lived (hours on the hobby plan) — fine for
// verifying the pipeline and small-scale testing, not a durable error store.
// When volume matters, swap the console.log for Upstash Redis / Vercel KV or
// point the extension at Sentry — the report shape already carries what
// Sentry would want.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const VERSION_RE = /^[\w.-]{1,32}$/

/** field → max length; everything else in the payload is dropped. */
const TEXT_FIELDS = {
  context: 40,
  error_class: 40,
  message: 300,
  stack: 1000,
  provider: 16,
  browser: 40,
}

module.exports = (req, res) => {
  // The extension's service worker is a cross-origin caller — allow it.
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'content-type')
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).end()

  const body = req.body ?? {}
  const installId = String(body.install_id ?? '')
  const version = String(body.app_version ?? '')
  if (
    body.event !== 'app_error' ||
    !UUID_RE.test(installId) ||
    !VERSION_RE.test(version)
  ) {
    return res.status(400).end()
  }

  const record = {
    event: 'app_error',
    install_id: installId,
    app_version: version,
    // Server time is authoritative; the client timestamp is advisory only.
    received_at: new Date().toISOString(),
  }
  for (const [field, max] of Object.entries(TEXT_FIELDS)) {
    if (typeof body[field] === 'string' && body[field]) {
      record[field] = body[field].slice(0, max)
    }
  }

  console.log('[error-report]', JSON.stringify(record))
  return res.status(204).end()
}
