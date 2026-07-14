# Chrome Web Store submission reference — Ad Sensei (full app)

Copy-paste source for the CWS developer dashboard fields. Written for the FULL
feature set (YouTube ad skipping + aggressive mode + anti-adblock scriptlets +
web blocking + AI sponsor detection). See the risk notes at the bottom — some of
these justifications describe behavior a reviewer may still reject; a store-safe
build variant is the lower-risk path.

> These are drafts. Have a human review the privacy policy and disclosures
> before submitting; this is not legal advice.

---

## Single-purpose description

> Ad Sensei removes advertising interruptions from web browsing: it blocks ads
> and trackers on websites and skips ads and sponsor segments on YouTube, so
> pages load cleaner and videos play without interruptions.

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

1. **YouTube ad circumvention with active evasion** (aggressive mode cloaks
   `Function.prototype.toString` and spoofs `/youtubei/v1/player`; the
   anti-adblock scriptlet layer defeats detection). Highest rejection/takedown
   risk. Off-by-default / permission-gated, but visible to reviewers. Strongest
   mitigation: ship a store build that excludes these two layers.
2. **Obfuscation is banned** — do NOT minify-to-conceal or obfuscate to hide the
   above; that is a separate, account-level violation. Compliance = not shipping
   the code, not hiding it.
3. **Single purpose** — keep the listing framed as "block ads and
   interruptions," not a feature grab-bag.
4. Ad blockers from new publishers get extra manual review; verify the
   publisher and expect a longer first review.
