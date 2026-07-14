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
/** The `cookies` permission is optional (requested from the popup on demand). */
export async function hasCookiesPermission(): Promise<boolean> {
  try {
    return await chrome.permissions.contains({ permissions: ['cookies'] })
  } catch {
    return false
  }
}

export async function clearCookiesFor(filter: {
  domain?: string
  url?: string
}): Promise<number> {
  // Optional permission: if it was never granted (e.g. the in-player recovery
  // panel path, which has no user gesture to request one), do nothing rather
  // than throw. The popup buttons request it before calling.
  if (!(await hasCookiesPermission())) return 0
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
