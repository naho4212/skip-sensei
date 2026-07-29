/**
 * Resume-position handling for the cookie-clear recovery path.
 *
 * Clearing YouTube's cookies is the only thing that lifts the ad-blocker
 * enforcement flag, but it also wipes the session that YouTube uses to resume
 * playback — so the reloaded video starts from 0:00 and the user loses their
 * place in a long video. The fix is to carry the position across the reload
 * ourselves: the ad engine samples the content video's currentTime while it
 * plays (never during an ad, where currentTime belongs to the ad), and the
 * reload navigates to the watch URL with `t=` set instead of plainly reloading.
 * YouTube honours `t=` on a cold load with no session at all, which is exactly
 * the state a cookie clear leaves behind.
 */

/** Don't bother restoring a position this early — the reload lands there anyway. */
export const MIN_RESUME_SECONDS = 10

/** Rewind slightly so the video resumes with a moment of context, not mid-word. */
const RESUME_LEAD_IN_SECONDS = 3

/**
 * Add/replace `t=` on a YouTube watch URL. Returns null when the URL isn't a
 * watch page or the position isn't worth restoring, so callers fall back to a
 * plain reload.
 */
export function withResumeTime(
  rawUrl: string,
  seconds: number,
): string | null {
  if (!Number.isFinite(seconds) || seconds < MIN_RESUME_SECONDS) return null
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  if (!/(^|\.)youtube\.com$/.test(url.hostname)) return null
  if (url.pathname !== '/watch' || !url.searchParams.get('v')) return null
  const at = Math.max(0, Math.floor(seconds) - RESUME_LEAD_IN_SECONDS)
  if (at < 1) return null
  // YouTube accepts a bare seconds count; `s` suffix is equivalent but the
  // plain integer is what its own share links use.
  url.searchParams.set('t', String(at))
  const next = url.toString()
  // Same URL in, same URL out (a `t=` link the user hit the wall on): a
  // navigation to an identical URL isn't guaranteed to be a real load, and a
  // plain reload already honours the `t=` that's sitting in the URL.
  return next === rawUrl ? null : next
}
