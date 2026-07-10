/**
 * User-facing "what's new" entries, newest first. The popup shows every entry
 * strictly newer than the version the user last acknowledged (see
 * getLastSeenVersion), so on each release: bump the version in
 * manifest.config.ts AND add an entry here with the user-visible changes.
 *
 * Keep items short and benefit-oriented — this is release notes for a viewer,
 * not a commit log. Omit purely internal changes.
 */
export interface ChangelogEntry {
  version: string
  date: string
  items: string[]
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: '0.2.2',
    date: '2026-07-10',
    items: [
      'Hides ads on thousands more sites, using per-site rules from the AdGuard filter list',
      'More reliable ad blocking after Chrome restarts and extension updates',
    ],
  },
  {
    version: '0.2.1',
    date: '2026-07-09',
    items: [
      'Blocks malware & phishing domains (URLhaus live list) — on by default, refreshed with every filter update',
      'Clearer ratings: "👍 Ad" / "👎 Not ad" buttons, plus one-tap Undo for saved choices per site',
      'Blocked-ad placeholders are easier to see, and empty ad slots that appear while you scroll now collapse too',
      'Popup: the hidden-ads review is now a collapsible section',
    ],
  },
  {
    version: '0.2.0',
    date: '2026-07-08',
    items: [
      'SponsorBlock: instant, exact sponsor skipping from the community database, with the AI as fallback — pick which segment types to skip in Settings',
      'Strip tracking parameters (utm_, fbclid, gclid, and more) from links as you browse',
      'Local-only mode: on-device AI only, zero external calls, no diagnostics',
      'YouTube extras: hide Shorts, hide end-screen cards, turn off autoplay, auto-dismiss "Continue watching?"',
      'Hides more YouTube ads: in-feed, masthead, and sidebar "Sponsored" cards',
    ],
  },
  {
    version: '0.1.0',
    date: '2026-07-08',
    items: [
      'Reliably skips back-to-back "ad pods", not just the first ad',
      'Smoother skips: the player is briefly covered while ads are removed',
      'Experimental Aggressive mode: block most YouTube ads before they even start (Settings)',
      'Recovers automatically if the player ever gets stuck on an ad',
    ],
  },
]

/** Compare dotted numeric versions. Returns -1 | 0 | 1 (a vs b). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff < 0 ? -1 : 1
  }
  return 0
}

/** Changelog entries strictly newer than `sinceVersion`, newest first. */
export function changesSince(sinceVersion: string): ChangelogEntry[] {
  return CHANGELOG.filter((e) => compareVersions(e.version, sinceVersion) > 0)
}
