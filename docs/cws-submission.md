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
| Item name | `Ad Sensei` (no "YouTube" — trademark in a listing title reads as implied affiliation) |
| Category | **Privacy & Security** |
| Language | English (United States) |
| Homepage URL | `https://www.singlefinmedia.com/ad-sensei` |
| Support URL | `https://github.com/naho4212/skip-sensei/issues` |
| Support email | `info@singlefinmedia.com` (matches the options → About contact link) |
| Visibility | Public, all regions |
| Pricing | Free, no in-app purchases |

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
> own provider key instead (Gemini, Claude, OpenAI, Groq, OpenRouter, or a
> local Ollama server) if you prefer. Either way there's no subscription and
> no server of ours in the loop.
>
> SMALL PERMISSIONS BY DEFAULT
> A fresh install asks for YouTube access and nothing broader. Access to all
> sites is optional and requested only at the moment you turn on a feature
> that needs it.
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

---

## Host permission justifications

**`*://*.youtube.com/*`** — Required to skip YouTube video ads and creator
sponsor segments and to hide YouTube's display ads, which run only on
youtube.com.

**`https://sponsor.ajay.app/*`** — Fetches community-marked sponsor segments
from SponsorBlock. Only a hashed prefix of the video ID is sent, so the service
cannot learn which video you're watching. Contacted only when SponsorBlock is
enabled.

**AI provider hosts** (`generativelanguage.googleapis.com`, `api.anthropic.com`,
`api.openai.com`, `api.groq.com`, `openrouter.ai`) — Sends a video's transcript
to the AI provider the user selects, to detect sponsor segments, and — only when
the user clicks "Refresh model list" — fetches that provider's list of available
models to populate the model picker (a plain read of the model catalog, no user
data). Contacted only when the user configures that provider; the default is
Chrome's on-device AI, which makes no network calls.

**`http://localhost/*`, `http://127.0.0.1/*`** — Lets users route AI analysis to
a local Ollama server or self-hosted gateway on their own machine, so no data
leaves their device (and, on "Refresh model list", reads the local server's list
of installed models). Contacted only if the user selects a local provider.

**Optional `*://*/*`** (requested at runtime, not at install) — Needed for the
opt-in features that have to run on sites other than YouTube:

1. **Hiding ads on every site** — the cosmetic layer registers its content
   script on all sites so it can hide ad elements that network blocking can't
   reach, e.g. first-party promoted tiles (`src/cosmetic-register.ts`, gated on
   the web-cosmetic setting). This is the main reason for the grant.
2. **Keeping ad-blocked pages usable** — the anti-adblock helper
   (`src/scriptlet-register.ts`, gated on `defuseAntiAdblock`).
3. **Stripping tracking parameters** from links the user clicks.

All three are requested with a permission prompt at the moment the user turns
the feature on; the base install never holds broad host access, and none of the
three registers anything until the grant exists (verified on a clean profile:
`chrome.scripting.getRegisteredContentScripts()` returns empty).

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

**User activity (analytics):** Yes, limited and optional — anonymous, scrubbed
crash/adaptation diagnostics (extension version, coarse browser tag, selected
provider name, scrubbed error text, the CSS selectors involved in an
ad-detection event, a random install id). Off in Local-only mode and
toggleable. No page titles, keys, or personal data.
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

**Privacy policy URL:** https://www.singlefinmedia.com/ad-sensei/privacy.html

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
   anti-adblock detection, never Chrome, and is **dormant on a base install** —
   it registers (MAIN world, via `chrome.scripting`) only after the user grants
   the optional all-sites permission AND enables `defuseAntiAdblock`, so a
   reviewer's default test install never activates it.

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
