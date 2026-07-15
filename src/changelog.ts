/**
 * User-facing "what's new" entries, newest first. The popup shows every entry
 * strictly newer than the version the user last acknowledged (see
 * getLastSeenVersion), so on each release: bump the version in package.json
 * (scripts/bump-version.mjs) AND add an entry here with the changes.
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
    version: '0.2.18',
    date: '2026-07-15',
    items: [
      'Fixed LinkedIn messages and search disappearing: generic ad selectors matched by substring, so "thread" and "typeahead" looked like "ad" — they now match whole name tokens only',
      'New safety guard: pattern-based ad selectors are dropped on any page where they touch real UI (search boxes, forms, menus, threads)',
      'The AI now audits what the filter lists hide: hidden elements that carry real text get read by the AI, and clear false positives (your content, site UI) are un-hidden automatically — reviewable in the popup, 👍 re-hides',
    ],
  },
  {
    version: '0.2.17',
    date: '2026-07-15',
    items: [
      'AI ad detection is now far stricter about what counts as an ad: an ad-like class name alone is no longer enough — the element must actually look like an ad unit, and the AI now sees the element\'s visible text and the page it\'s on before confirming anything',
      'Gmail, Outlook, and other mail/chat/docs apps are now completely off-limits to the AI ad scanner — your emails and messages are never candidates (Gmail internally labels every email "ads", which fooled the scanner)',
      'Anything the AI wrongly hid on those apps before this fix un-hides itself automatically on your next visit',
    ],
  },
  {
    version: '0.2.16',
    date: '2026-07-15',
    items: [
      'Ad counting now counts ads, not requests: every ad slot removed from a page counts as one blocked ad — including slots left empty because the ad was stopped before it could even load (blocking one ad script can kill every ad on the page; the count now reflects that)',
      'The "blocked here" breakdown and the hidden-ads list finally agree — empty slots are tagged "empty" in the review list with an explanation of where their ad went',
      'Global stats moved to a "Blocked everywhere" block at the bottom of the This-site view, so per-site and lifetime numbers stop reading as the same thing',
    ],
  },
  {
    version: '0.2.15',
    date: '2026-07-14',
    items: [
      'Redesigned popup: two views — “This site” (blocking status, stats, and per-page tools) and “Controls” (every toggle, now including aggressive mode and tappable pills for the five web-blocking lists) — with nothing cut off and the footer always in reach',
      'Honest ad counting: the per-site "blocked here" number and the popup totals now measure the same thing, so your totals are simply every page\'s number added up',
      'One ad now counts as one — nested fragments of the same ad slot are counted once, and a hidden slot only counts as an ad when an ad had actually loaded in it (empty leftovers of already-blocked ads no longer inflate the number)',
      'Stat cards now show "today" instead of "this session" — a number you can actually reason about',
      'Fixed a stray "reload to clear ads" hint appearing for ad frames that were already blocked',
    ],
  },
  {
    version: '0.2.14',
    date: '2026-07-14',
    items: [
      'The Ad Sensei skip overlay is back — a calm branded panel covers the player while an ad is being skipped, instead of the fast-forward flicker',
      'One activity entry per ad break: consecutive ads are combined into a single line showing how much ad time was skipped and how fast',
      'The welcome page now sets you up in one decision: pick a blocking level (Essential / Balanced / Max, each listing exactly what it turns on), or jump to settings to build your own',
      'Recommended free AI pair, right on the welcome page: add Gemini and Groq keys side by side — Gemini analyzes transcripts while quick helpers automatically run on Groq, so neither hits its free-tier limits ("Maybe later" leaves a reminder in the popup)',
    ],
  },
  {
    version: '0.2.13',
    date: '2026-07-14',
    items: [
      'Web-wide ad hiding now asks for all-sites access only when you turn it on — a fresh install stays scoped to YouTube',
      'Cookie clearing and cloud AI providers now request permission only when you use them, so the extension asks for less up front',
      'The AI page-cleanup helpers now stay on your device whenever Chrome’s built-in AI is available',
      'Clearer first-run note about optional, anonymous crash reports, with a toggle right there',
    ],
  },
  {
    version: '0.2.12',
    date: '2026-07-14',
    items: [
      'When YouTube fully blocks playback for ad blocking, the player now shows a recovery panel with a one-click "Clear YouTube cookies & reload" fix (instead of a silent black screen)',
      "Fixed cookie clearing missing YouTube's partitioned session cookies — the ones the ad-blocker flag actually lives on — so the fix now really lifts the block",
    ],
  },
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
