/**
 * Cookie clearing that actually lifts anti-adblock flags.
 *
 * YouTube (and increasingly other sites) store their session identifiers as
 * CHIPS-partitioned cookies — on YouTube that includes VISITOR_INFO1_LIVE and
 * YSC, the cookies the ad-blocker strike flag rides on. A plain
 * chrome.cookies.getAll({ domain }) returns ONLY unpartitioned cookies, so it
 * silently misses them and the "cleared" wall comes right back. Passing
 * partitionKey: {} returns partitioned and unpartitioned cookies alike, and
 * each remove() must echo the cookie's own partitionKey to hit the
 * partitioned copy.
 */
export async function clearCookiesFor(filter: {
  domain?: string
  url?: string
}): Promise<number> {
  const cookies = await chrome.cookies.getAll({ ...filter, partitionKey: {} })
  await Promise.all(
    cookies.map((c) => {
      const url = `http${c.secure ? 's' : ''}://${c.domain.replace(/^\./, '')}${c.path}`
      return chrome.cookies
        .remove({
          url,
          name: c.name,
          storeId: c.storeId,
          ...(c.partitionKey ? { partitionKey: c.partitionKey } : {}),
        })
        .catch(() => undefined)
    }),
  )
  return cookies.length
}
