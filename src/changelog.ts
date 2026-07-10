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
    version: '0.2.11',
    date: '2026-07-10',
    items: ['Polished the welcome page and fixed its layout.'],
  },
  {
    version: '0.2.10',
    date: '2026-07-10',
    items: [
      'Redesigned settings: one page with a sidebar — YouTube, Ad blocking, AI & privacy, Analytics, Activity & logs, and About',
      'New Analytics dashboard shows lifetime and this-session totals at a glance',
    ],
  },
  {
    version: '0.2.9',
    date: '2026-07-10',
    items: [
      'Hidden YouTube display ads now count in the YouTube stat card, so it no longer reads 0 while the page shows ads blocked',
    ],
  },
  {
    version: '0.2.8',
    date: '2026-07-10',
    items: [
      'Aggressive mode’s ad count now reflects the real number of ad breaks avoided per video, no longer inflated by YouTube re-checking the page',
    ],
  },
  {
    version: '0.2.7',
    date: '2026-07-10',
    items: [
      'Fixed the YouTube “ads skipped” count over-counting in aggressive mode — it now reflects real ad breaks removed',
    ],
  },
  {
    version: '0.2.6',
    date: '2026-07-10',
    items: [
      'Aggressive mode now works on its own — enable it without needing “Skip YouTube ads” turned on',
      'The “blocked here” count updates live as ads are hidden on the page',
    ],
  },
  {
    version: '0.2.5',
    date: '2026-07-10',
    items: [
      'Fixed: the “This video” panel no longer appears on pages that aren’t YouTube and don’t embed a YouTube video',
      'New: reset your stats anytime — Settings → History &amp; logs → Reset statistics',
    ],
  },
  {
    version: '0.2.4',
    date: '2026-07-10',
    items: [
      'AI enhancements now toggle right from the popup — flip it to compare AI-assisted blocking against filter lists alone',
      'The per-page “blocked here” count is now accurate on sites that load ads after the page opens',
      '“This video” only appears on YouTube or pages that actually embed a YouTube video',
    ],
  },
  {
    version: '0.2.3',
    date: '2026-07-10',
    items: [
      'New Settings → Filter rulesets panel: switch each blocking list on or off, and see its rule count, its source, and how many rules are actually loaded',
    ],
  },
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
