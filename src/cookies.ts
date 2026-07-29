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
 * The cookies that carry YouTube's *visitor* identity — and with it the
 * ad-blocker strike that produces the enforcement wall. Deliberately excludes
 * the Google auth set (SID/HSID/SSID/APISID/SAPISID/__Secure-*PSID), which
 * lives on .youtube.com too: dropping those is what signs you out. Rotating
 * only these resets the visitor the strike is attached to while the session
 * stays logged in.
 *
 * Caveat worth keeping honest: the full-wipe remedy proved the flag dies with
 * SOME youtube.com cookie, not specifically with these. If YouTube also parks
 * the strike somewhere outside this list, rotation quietly stops working — so
 * the wall path still falls back to clearing everything.
 */
export const YT_VISITOR_COOKIES = [
  'VISITOR_INFO1_LIVE',
  'VISITOR_PRIVACY_METADATA',
  'YSC',
  '__Secure-YEC',
  'GPS',
]

/** The `cookies` permission is optional (requested from the popup on demand). */
export async function hasCookiesPermission(): Promise<boolean> {
  try {
    return await chrome.permissions.contains({ permissions: ['cookies'] })
  } catch {
    return false
  }
}

/**
 * Drop just the visitor cookies, leaving the login untouched. Returns how many
 * were removed (0 when the optional `cookies` permission isn't granted).
 */
export async function rotateYtVisitorCookies(): Promise<number> {
  return clearCookiesFor({ domain: 'youtube.com' }, YT_VISITOR_COOKIES)
}

export async function clearCookiesFor(
  filter: {
    domain?: string
    url?: string
  },
  /** When given, only cookies with these exact names are removed. */
  onlyNames?: string[],
): Promise<number> {
  // Optional permission: if it was never granted (e.g. the in-player recovery
  // panel path, which has no user gesture to request one), do nothing rather
  // than throw. The popup buttons request it before calling.
  if (!(await hasCookiesPermission())) return 0
  const all = await chrome.cookies.getAll({ ...filter, partitionKey: {} })
  const cookies = onlyNames
    ? all.filter((c) => onlyNames.includes(c.name))
    : all
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
