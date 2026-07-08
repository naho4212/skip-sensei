// Ad Sensei error-report collector (Vercel serverless function).
//
// Accepts POST app_error events from the extension, whitelists and caps every
// field, and persists each report as one JSON blob in Vercel Blob
// (`errors/<day>/<timestamp>.json`), plus a line in the function log.
// Query recent reports via GET /api/errors?key=<ERROR_LOG_READ_KEY>.
//
// Reports are secret-scrubbed by the extension before they're sent and again
// capped here; blob URLs carry unguessable random suffixes, and listing
// requires the store token.

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

module.exports = async (req, res) => {
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

  const line = JSON.stringify(record)
  console.log('[error-report]', line)

  // Durable copy in Vercel Blob. Day-prefixed, timestamp-named pathnames sort
  // chronologically, which is what /api/errors relies on to return the most
  // recent reports first. A blob failure must never bounce the client.
  try {
    const { put } = await import('@vercel/blob')
    const stamp = record.received_at.replace(/[:.]/g, '-')
    await put(`errors/${stamp.slice(0, 10)}/${stamp}.json`, line, {
      access: 'public',
      contentType: 'application/json',
      addRandomSuffix: true,
    })
  } catch (err) {
    console.log('[error-report] blob write failed:', err && err.message)
  }

  return res.status(204).end()
}
