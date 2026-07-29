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
 * YouTube's *visitor* identity — the cookies the ad-blocker strike is believed
 * to ride on. Deliberately excludes the Google auth set (SID/HSID/SSID/APISID/
 * SAPISID/__Secure-*PSID), which also lives on .youtube.com: dropping those is
 * what signs the user out.
 *
 * OPEN QUESTION, do not assume either way: whether clearing only these lifts
 * the wall, and whether the login survives it. The full wipe proved the flag
 * dies with SOME youtube.com cookie, never that it dies with these. A v0.3.2
 * attempt to rotate them automatically was pulled untested (see the v0.3.3
 * revert); the wall panel's two-stage clear is how we find out for real, with
 * the full wipe still there as the fallback that definitely works.
 */
export const YT_VISITOR_COOKIES = [
  'VISITOR_INFO1_LIVE',
  'VISITOR_PRIVACY_METADATA',
  'YSC',
  '__Secure-YEC',
  'GPS',
]

/** Drop only the visitor cookies, leaving the login in place. */
export function clearYtVisitorCookies(): Promise<number> {
  return clearCookiesFor({ domain: 'youtube.com' }, YT_VISITOR_COOKIES)
}

/** The `cookies` permission is optional (requested from the popup on demand). */
export async function hasCookiesPermission(): Promise<boolean> {
  try {
    return await chrome.permissions.contains({ permissions: ['cookies'] })
  } catch {
    return false
  }
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
  const cookies = onlyNames ? all.filter((c) => onlyNames.includes(c.name)) : all
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
