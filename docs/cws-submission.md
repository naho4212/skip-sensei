# Chrome Web Store submission reference — Ad Sensei

Copy-paste source for the CWS developer dashboard fields.

**One build.** `npm run build` produces the single artifact used everywhere —
daily load-unpacked use, the landing download, and the Web Store submission
(zip via `npm run package`). It contains no outbound-request manipulation: the
YouTube `/youtubei/v1/player` request rewrite that once existed was the single
highest-risk behavior, an A/B proved it redundant (see note 1), and it was
removed outright. Everything else — web/tracker blocking, response-side YouTube
pruning, reactive ad skipping, AI sponsor detection — is unchanged.

> These are drafts. Have a human review the privacy policy and disclosures
> before submitting; this is not legal advice.

---

## Single-purpose description

> Ad Sensei is an ad blocker. It blocks third-party ads and trackers across the
> web using filter lists, and hides the first-party ads that sites serve from
> their own domains — on Pinterest, Amazon, Reddit, and others, and on YouTube,
> where it also removes in-stream video ads and creator sponsor segments. The
> result: pages load cleaner and videos play without interruptions.

Keep the listing framed on this one purpose. Do not enumerate every sub-feature
as if they were separate products.

---

## Store listing fields

| Field | Value |
|---|---|
| Item name | `Ad Sensei — AI Ad Blocker for All Ads & YouTube™ Sponsor Skip` (61 chars; mirrors `manifest.name`). Supersedes the earlier no-"YouTube" stance: live SERPs show Featured extensions using nominative "for YouTube™" at the END of the name (SponsorBlock for YouTube, SkipSponsor). Leading with "YouTube" would still read as implied affiliation — don't. |
| Category | **Privacy & Security** |
| Language | English (United States) |
| Homepage URL | `https://www.singlefinmedia.com/ad-sensei` |
| Support URL | `https://www.singlefinmedia.com/ad-sensei/support` (hosted contact form; GitHub issues linked from it) |
| Support email | `info@singlefinmedia.com` (matches the options → About contact link) |
| Visibility | Public, all regions |
| Pricing | Free, no in-app purchases |
| Screenshots | 5 in `docs/cws-screenshots/` (1280×800), built by `gen.mjs` |
| Small promo tile | `docs/cws-screenshots/promo-tile-440x280.png` — upload it; an empty tile slot disqualifies the automated Featured-badge check |
| Marquee promo tile | `docs/cws-screenshots/marquee-1400x560.png` — also required for the Featured check ("it only shows if featured" inverts causality; an empty slot is what prevents featuring) |

**Summary / short description** (132 char max — mirrors `manifest.description`,
which the extensions page shows; keep the two in sync):

> Block ads and trackers across the web — plus in-video ads and AI-detected
> sponsor segments on YouTube.

**Detailed description** (paste as-is; plain text, the store renders no markup):

> **Ad Sensei blocks ads and trackers everywhere — and skips the ones that
> can't be blocked.**
>
> Most blockers stop third-party ad requests and stop there. Ad Sensei does
> that, using bundled filter lists evaluated by Chrome's own declarative
> engine, and then handles the ads that arrive from a site's own servers,
> where request blocking can't reach: promoted tiles on Pinterest, sponsored
> results on Amazon and Reddit, feed ads and in-stream video ads on YouTube.
>
> WHAT IT DOES
> • Blocks ads, trackers, malware domains, cookie notices, and social widgets
> • Hides the first-party "sponsored" placements sites serve themselves
> • Skips YouTube video ads — pre-roll, mid-roll, and post-roll
> • Skips creator sponsor reads inside videos, via SponsorBlock's community
>   data or an optional AI transcript analysis
> • Shows what it blocked on the page you're on, with a one-click pause per site
>
> PRIVACY
> No account, no sign-in, no advertising profile. Blocking is evaluated by
> Chrome's own engine, so the extension never inspects your requests. Optional
> anonymous diagnostics report the domain where an ad-detection problem
> happened (never full addresses, titles, or page content) so wrong hides can
> be fixed — switch them off in one click, and Local-only mode disables every
> network call the extension makes.
>
> AI THAT STAYS ON YOUR DEVICE
> Sponsor detection and the other AI helpers prefer Chrome's built-in
> on-device model, which sends nothing anywhere. You can point them at your
> own AI provider's API key instead — any major cloud provider or a local
> self-hosted model — if you prefer. Either way there's no subscription and
> no server of ours in the loop.
>
> BALANCED BY DEFAULT
> Web-wide ad, tracker, cookie-notice, and popup blocking is on from the
> first page load — no setup. Dial it down to YouTube-only or up to Max from
> the welcome page or the popup at any time.
>
> HONEST ABOUT THE LIMITS
> YouTube stitches some ads into the video stream itself. Those can't be
> prevented from loading by any extension — Ad Sensei skips them as they
> start, so you see about a second rather than thirty. Anything claiming
> otherwise on a stream-inserted ad is overselling.
>
> Free and open source (MIT): https://github.com/naho4212/skip-sensei

**Claim discipline:** every line above maps to a shipped feature, and the
limits paragraph is deliberate — "zero ads" / "never think about an ad again"
style copy is a misleading-claims risk and was already scrubbed from the
landing page. Keep the two in sync.

**Listing identity discipline** (from the Jan-2025 CWS-search-abuse exposé and
the MADWeb 2026 cross-store study — name/author churn is a measured
malware-correlated signal that automated triage now keys on):

- **No renames after first publish.** If "Ad Sensei" is ever going to change,
  change it BEFORE submission (the `wxt.config.ts` single-string affordance is
  for that moment, not for post-publish rebrands).
- **No competitor names anywhere in the listing** — "alternative to
  uBlock/AdBlock" copy is the exact placement-manipulation pattern CWS policy
  bans, even when it's honest positioning.
- **If the listing is ever localized, translate faithfully.** Localized
  descriptions are in a public dataset that researchers scan for
  keyword-stuffed pseudo-translations; a sloppy machine translation with
  English keywords left in pattern-matches to the abuse clusters.
- **If an Edge Add-ons port ever happens:** identical extension name,
  publisher name, and description, same support email — cross-store detail
  divergence is what evasive actors do to break counterpart mapping, and
  tooling now flags it.
- **Never add Google Analytics (or any third-party analytics) to the
  extension.** GA-as-camouflage is a documented exfiltration pattern in
  malicious extensions; all telemetry stays first-party, disclosed, on the
  `reportEvent` chokepoint.

---

## Permission justifications

**storage** — Stores your settings, statistics, the per-video sponsor-analysis
cache, and local activity/settings logs in the browser. No remote storage.

**activeTab** — Lets the popup read the current tab (host and blocked count) so
it can show status and the "pause on this site" control for the page you're on.

**scripting** — Registers the extension's in-page helpers at document start in
the page's context (the YouTube ad-pruning helper and, only where you grant
access, the anti-adblock helper). Used solely to run the extension's own
bundled scripts; no remote code is loaded or executed.

**declarativeNetRequest** — Powers ad, tracker, cookie-notice, and malware
blocking using filter lists bundled in the extension. Blocking is declarative
and evaluated by the browser; the extension never sees your requests.

**declarativeNetRequestFeedback** — Lets the extension count how many requests
its own rules blocked, to show the "blocked here" number and lifetime totals.
It reads only match counts, not request contents.

**alarms** — Schedules the periodic check for updated ad-filter rules (see the
Website-content data note below). Only used to time that background check.

**cookies (optional)** — Requested at runtime, only when the user clicks a
"clear this site's cookies" recovery button (lifting an ad-blocker-detection
wall). Cookies are enumerated solely to DELETE them in that user-initiated
action; cookie values are never read for any other purpose, never stored, and
never leave the browser. The base install holds no cookie access.
*Reviewer context: `chrome.cookies.getAll` is a known exfiltration-pattern API
(published malware case studies steal session cookies with it), so expect this
one to be scrutinized — the justification above should be pasted verbatim, and
the code path (`src/cookies.ts`) shows enumerate→remove with no network write.*

---

## Host permission justifications

*(Since 0.3.16 the only host permission is `*://*/*`; `*.youtube.com`,
SponsorBlock, and the AI-provider hosts were folded into it — SponsorBlock and
the AI APIs are all CORS-open and work without a grant regardless.)*

**`*://*/*`** — Ad Sensei is a general-purpose ad blocker; like every ad
blocker it needs to act on every site the user visits:

1. **Hiding ads on every site** — the cosmetic layer runs its content script
   on all sites to hide ad elements that network blocking can't reach, e.g.
   first-party promoted tiles and empty ad containers left behind by blocked
   requests (`src/cosmetic-register.ts`). This is the main reason for the
   permission.
2. **Skipping YouTube video ads and creator sponsor segments** and hiding
   YouTube's display ads (`entrypoints/youtube.content.ts`).
3. **Keeping ad-blocked pages usable** — the anti-adblock helper
   (`src/scriptlet-register.ts`, gated on `defuseAntiAdblock`).
4. **Stripping tracking parameters** from links (`url_tracking` ruleset, Max
   level only) — DNR `redirect`/`transform` rules need host access.

Fetches to SponsorBlock (`sponsor.ajay.app`, hashed video-ID prefix only) and
to the AI provider the user configures (video transcript; default is Chrome's
on-device model, which makes no network call) are plain CORS requests and do
not depend on this permission.

The permission is granted at install (Chrome's standard "Read and change all
your data on all websites" prompt). Each layer still registers only while its
own setting is on, and every one of them can be switched off — or the whole
extension paused per site — from the popup.

---

## Data use disclosures (certification)

**Personally identifiable information:** No.
**Health / financial / authentication / personal communications / location:** No.
**Web history:** **Yes** — must be certified, do not answer No. Ad-detection
diagnostic events include the bare domain of the page they fired on (`host`,
added in `service-worker.ts`'s `skipSensei:event` case, plus a `domain` field in
the cosmetic layer's own payloads). Because those events fire as the user
browses, they are a partial, sampled record of visited domains, associated with
a random install id. Never full URLs, paths, query strings, or page titles.
Collected solely to diagnose a wrongly hidden element on a specific site — a
gap-filler false positive is not fixable without knowing where it happened.
Optional (one toggle), off in Local-only mode.

> Answering "No" here would be false certification, which is an account-level
> violation and far worse than the disclosure itself. If the `host`/`domain`
> fields are ever removed, flip this back to No — and not before.

**User activity (analytics):** Yes, limited and optional — (a) anonymous,
scrubbed crash/adaptation diagnostics (extension version, coarse browser tag,
selected provider name, scrubbed error text, the CSS selectors involved in an
ad-detection event, a random install id); (b) one aggregate report per day of
how the extension's OWN interface was used — popup opens, which of its tabs,
toggles, and buttons were clicked (setting names only, never typed values) —
to guide UI improvements. Both ride the same consent toggle, off in Local-only
mode. The usage counts cover Ad Sensei's controls only — never which sites the
user visits. No page titles, keys, or personal data.
**Website content:** Yes — (a) a YouTube video transcript is sent to the user's
chosen AI provider for sponsor detection, only when a cloud provider is
selected (never with on-device/local AI or in Local-only mode); (b) for the
optional AI enhancements (ad-candidate verification, popup review,
cookie-banner auto-reject, selector self-heal), a short snippet of page markup
(≤5 KB, never the full page) may be sent to that same provider — but only as a
fallback when Chrome's built-in on-device model is unavailable; with the
on-device model present these helpers never leave the device. Both disclosed
in the privacy policy.

**Remote data (not user data):** the extension periodically downloads refreshed
filter-rule lists (CSS selectors that identify ad elements) from our update
server (`www.singlefinmedia.com/ad-sensei/filters`). This is a one-way download
of DATA — no remote code — integrity-checked (SHA-256) before use; static
network rulesets remain bundled and update only with releases. The request sends
no user data (a plain GET); the server sees only that some install checked in
and its version. On by default, toggleable, off in Local-only mode. Disclosed in
the privacy policy (section 4).

**Certifications (all true):**
- Data is NOT sold or transferred to third parties for purposes unrelated to
  the item's single purpose.
- Data is NOT used or transferred for advertising or creditworthiness.
- Data use is limited to providing the user-facing features.

**Privacy policy URL:** https://www.singlefinmedia.com/ad-sensei/privacy

All three outbound hosts now sit on this same origin — telemetry
(`src/error-reporting.ts`), filter updates (`src/filter-updates.ts`), and the
policy itself — so a reviewer sees one publisher domain, not a Vercel
scaffolding alias. singlefin's Next project rewrites `/ad-sensei/:path+` to the
landing project and preserves the CORS + cache headers; keep that rewrite in
place. If the origin ever moves, all three must move together.

---

## Known review-risk notes (read before submitting the full app)

1. **YouTube player-response manipulation** (`public/prune-main.js`, gated
   behind the first-party ad-blocking setting). Two distinct behaviors that must
   not be conflated:

   a. **Outbound request rewrite** — REMOVED. An earlier build set
      `clientScreen = "CHANNEL"` on the `/youtubei/v1/player` request to solicit
      an ad-free response variant. That was request tampering — not a standard
      blocker technique — and the genuine outlier / highest-risk item. A
      behavioral A/B (spoof vs. no-spoof build, on YouTube's free-with-ads
      catalog) confirmed it was redundant: response-side json-prune already
      empties the player's ad schedule (the player held 0 of 6 ad placements
      with the spoof absent), so it was deleted from the source outright. The
      shipping build never manipulates an outbound request. (Code preserved in
      git history + project memory if it ever needs restoring for a non-store
      channel.)

   b. **Response-side json-prune** (scrubs `adPlacements`/`adSlots` etc. out of
      the player response): **present, and it's what does the blocking.** Same
      class as uBlock Origin's `json-prune` scriptlet, but note it still reads as
      "modifies YouTube's player data," which general-purpose store blockers
      don't ship by default. Residual, lower risk. If a reviewer pushes back
      specifically on this, the fallback is a build that also drops json-prune
      and relies on reactive skipping only — less effective, so not the default.
      Off-by-default / permission-gated either way.

   NOT a distinguishing risk: the `Function.prototype.toString` cloaking and the
   anti-adblock `set-constant` scriptlets (`public/scriptlets-main.js`) are a
   documented subset of uBlock Origin's scriptlet library — the same `safeSelf`
   toString-cloak pattern ships in uBlock Origin Lite on the Web Store today. It
   reads as evasion out of context, but it's standard, store-approved technique;
   don't let its presence drive the build decision. It also targets *website*
   anti-adblock detection, never Chrome. It registers (MAIN world, via
   `chrome.scripting`) when `defuseAntiAdblock` is on — which it is by default
   since 0.3.16 (Balanced default + install-time all-sites access), so a
   reviewer's default test install DOES run it on general sites.

2. **Always-on YouTube network exemption** (`yt_exempt`, the one ruleset that
   ships enabled) — a single `allowAllRequests` rule for youtube.com, present
   from install time. A reviewer may ask why an ad blocker whitelists
   YouTube's network requests: network-blocking YouTube trips its anti-adblock
   enforcement walls, so it is a hard project constraint that YouTube is never
   blocked at the network layer. All YouTube ad handling is response-side
   pruning, cosmetic hiding, and reactive skipping — the exemption just makes
   the constraint structural (no runtime ordering, no dynamic-rule race). It
   allows requests; it never reads or modifies them.
3. **Differential filter-list updates** (`src/filter-updates.ts`) — the
   extension periodically fetches refreshed cosmetic-filter DATA (a manifest +
   `domain -> css-selector[]` shards) from `www.singlefinmedia.com/ad-sensei`.
   This is the store-sanctioned remote-*data* / configuration path that every
   filter-list blocker uses, NOT remote code: no script is ever fetched or run.
   Each payload is SHA-256-verified against the manifest, sanitized
   per-comma-part (universal/structural selectors stripped), validated via
   `querySelector`, and rejected if older than the last-applied payload
   (`generatedAt` replay floor) before it can only ever become
   `selector{display:none}` CSS — fetched data cannot reach the scriptlet
   engine or any code path. On by default, toggleable, off in Local-only mode;
   disclosed in the privacy policy (§4). Static network (DNR) rulesets stay
   bundled and update only with releases.
4. **Domain collection in diagnostics is certified, and default-on.** The
   `host`/`domain` fields (see the Web history disclosure above) are the one
   piece of browsing-related data that leaves the browser. Disclosed in four
   places that must stay in sync with the code: privacy policy §3 + §5, the
   onboarding "Your data" card, the options tooltip, and the header comment in
   `src/error-reporting.ts`. Residual risk a reviewer may raise: the toggle
   ships **pre-checked**, so consent is opt-out rather than affirmative, and
   CWS expects prominent disclosure plus consent for this data class. The
   disclosure is prominent (first-run card, not buried), which is why on-by-
   default is defensible — but if a reviewer objects, the cheap fix is shipping
   the onboarding checkbox unchecked rather than removing the field.
5. **Obfuscation is banned** — do NOT minify-to-conceal or obfuscate to hide the
   above; that is a separate, account-level violation. Compliance = not shipping
   the code, not hiding it.
6. **Single purpose** — keep the listing framed as "block ads and
   interruptions," not a feature grab-bag.
7. Ad blockers from new publishers get extra manual review; verify the
   publisher and expect a longer first review.
