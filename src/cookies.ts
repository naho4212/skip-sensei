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
/**
 * Rotating ONLY the visitor cookies (VISITOR_INFO1_LIVE, YSC, …) while keeping
 * the Google auth set was tried in v0.3.2 and reverted in v0.3.3: verified
 * against a real signed-in account, it signs the user out anyway. The deletion
 * is genuinely name-scoped — no auth cookie is ever touched — but YouTube
 * invalidates a session whose visitor identity has vanished underneath it. A
 * sandbox can't show this (no account to lose), so don't re-derive it from
 * "the removal only names visitor cookies" and try again.
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
