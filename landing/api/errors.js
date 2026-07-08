// Ad Sensei report reader: newest-first JSON list of the records that
// /api/error and /api/event persisted to Vercel Blob.
//
//   GET /api/errors?key=<ERROR_LOG_READ_KEY>[&limit=50][&type=errors|events]
//
// `type=errors` (default) reads crash reports; `type=events` reads
// operational events (self-heals, gapfills, aggressive-mode breaker trips).
// Gated by the ERROR_LOG_READ_KEY env var so these details aren't
// world-readable. The key lives in the Vercel project env.

const MAX_LIMIT = 200

module.exports = async (req, res) => {
  const expected = process.env.ERROR_LOG_READ_KEY
  const given =
    req.query.key ??
    (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
  if (!expected || given !== expected) return res.status(401).end()

  const limit = Math.min(
    parseInt(String(req.query.limit ?? '50'), 10) || 50,
    MAX_LIMIT,
  )
  const prefix = req.query.type === 'events' ? 'events/' : 'errors/'

  const { list } = await import('@vercel/blob')
  const blobs = []
  let cursor
  do {
    const page = await list({ prefix, cursor, limit: 1000 })
    blobs.push(...page.blobs)
    cursor = page.cursor
  } while (cursor)

  // Pathnames are timestamp-named, so lexicographic order = chronological.
  const recent = blobs
    .sort((a, b) => (a.pathname < b.pathname ? 1 : -1))
    .slice(0, limit)

  const reports = (
    await Promise.all(
      recent.map(async (blob) => {
        try {
          const body = await fetch(blob.url)
          return await body.json()
        } catch {
          return null
        }
      }),
    )
  ).filter(Boolean)

  res.setHeader('cache-control', 'no-store')
  return res.status(200).json({ total_stored: blobs.length, reports })
}
