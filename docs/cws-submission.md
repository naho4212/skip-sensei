# Chrome Web Store submission reference — Ad Sensei

Copy-paste source for the CWS developer dashboard fields.

**Submit the CWS build, not the full build.** `npm run build:cws` produces
`.output/chrome-mv3-cws/` (+ `ad-sensei-cws-v<version>.zip`) — identical to the
full load-unpacked build except the outbound `/youtubei/v1/player` request
rewrite is stripped out (the `CWS-STRIP` block in `public/prune-main.js`, cut by
`scripts/make-cws-build.mjs`). That request rewrite was the single
highest-risk behavior and an A/B proved it redundant (see note 1), so removing
it costs no ad-blocking effectiveness. Everything else — web/tracker blocking,
response-side YouTube pruning, reactive ad skipping, AI sponsor detection — is
unchanged.

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
to the AI provider the user selects, to detect sponsor segments. Contacted only
when the user configures that provider; the default is Chrome's on-device AI,
which makes no network calls.

**`http://localhost/*`, `http://127.0.0.1/*`** — Lets users route AI analysis to
a local Ollama server or self-hosted gateway on their own machine, so no data
leaves their device. Contacted only if the user selects a local provider.

**Optional `*://*/*`** (requested at runtime, not at install) — Needed only for
two opt-in features: stripping tracking parameters from links you click, and
neutralizing "disable your ad blocker" walls. Requested with a permission prompt
at the moment the user enables those features; the base install never holds
broad host access.

---

## Data use disclosures (certification)

**Personally identifiable information:** No.
**Health / financial / authentication / personal communications / location:** No.
**Web history:** No — the extension does not collect or transmit the sites you
visit.
**User activity (analytics):** Yes, limited and optional — anonymous, scrubbed
crash/adaptation diagnostics (extension version, coarse browser tag, selected
provider name, scrubbed error text, a self-heal CSS selector, a random install
id). Off in Local-only mode and toggleable. No URLs, titles, keys, or personal
data.
**Website content:** Yes — (a) a YouTube video transcript is sent to the user's
chosen AI provider for sponsor detection, only when a cloud provider is
selected (never with on-device/local AI or in Local-only mode); (b) for the
optional AI enhancements (ad-candidate verification, popup review,
cookie-banner auto-reject, selector self-heal), a short snippet of page markup
(≤5 KB, never the full page) may be sent to that same provider — but only as a
fallback when Chrome's built-in on-device model is unavailable; with the
on-device model present these helpers never leave the device. Both disclosed
in the privacy policy.

**Certifications (all true):**
- Data is NOT sold or transferred to third parties for purposes unrelated to
  the item's single purpose.
- Data is NOT used or transferred for advertising or creditworthiness.
- Data use is limited to providing the user-facing features.

**Privacy policy URL:** https://landing-beta-three-23.vercel.app/privacy.html
(replace with the custom domain once one is attached — it must stay in sync
with the telemetry endpoint host in `src/error-reporting.ts`)

---

## Known review-risk notes (read before submitting the full app)

1. **YouTube player-response manipulation** (`public/prune-main.js`, gated
   behind the first-party ad-blocking setting). Two distinct behaviors that must
   not be conflated:

   a. **Outbound request rewrite** (section 4, the `CWS-STRIP` block): set
      `clientScreen = "CHANNEL"` on the `/youtubei/v1/player` request to solicit
      an ad-free response variant. This is request tampering — not a standard
      blocker technique — and was the genuine outlier / highest-risk item.
      **RESOLVED for the store build: `make-cws-build.mjs` strips it, so the CWS
      artifact never touches an outbound request.** An in-repo behavioral A/B
      (full vs. spoof-stripped build, on YouTube's free-with-ads catalog)
      confirmed it was redundant — response-side json-prune already empties the
      player's ad schedule (the player held 0 of 6 ad placements with the spoof
      absent), so dropping it changed nothing a user sees.

   b. **Response-side json-prune** (scrubs `adPlacements`/`adSlots` etc. out of
      the player response): **still present in the CWS build.** This is the same
      class as uBlock Origin's `json-prune` scriptlet and is what actually does
      the blocking, but note it still reads as "modifies YouTube's player data,"
      which general-purpose store blockers don't ship by default. Residual,
      lower risk. If a reviewer pushes back specifically on this, the fallback is
      a build that also drops json-prune and relies on reactive skipping only —
      less effective, so not the default. Off-by-default / permission-gated
      either way.

   NOT a distinguishing risk: the `Function.prototype.toString` cloaking and the
   anti-adblock `set-constant` scriptlets (`public/scriptlets-main.js`) are a
   documented subset of uBlock Origin's scriptlet library — the same `safeSelf`
   toString-cloak pattern ships in uBlock Origin Lite on the Web Store today. It
   reads as evasion out of context, but it's standard, store-approved technique;
   don't let its presence drive the build decision.
2. **Obfuscation is banned** — do NOT minify-to-conceal or obfuscate to hide the
   above; that is a separate, account-level violation. Compliance = not shipping
   the code, not hiding it.
3. **Single purpose** — keep the listing framed as "block ads and
   interruptions," not a feature grab-bag.
4. Ad blockers from new publishers get extra manual review; verify the
   publisher and expect a longer first review.
