# skip-sensei

A Chrome extension (Manifest V3) that removes ads and interruptions across the
web — with AI where filter lists can't reach. Everything runs in your browser;
there's no backend, no account, and nothing hosted.

> **Naming:** the public/store name is **Ad Sensei** and appears only in
> `manifest.config.ts` (plus store listing/assets). Everything in code —
> package name, storage keys, namespaces — is `skip-sensei` / `skipSensei`,
> so a store-driven rebrand never touches the code.

## What it does

**YouTube ads**
- Reactive skipping: clicks "Skip" the instant it appears, fast-forwards
  un-skippable ads (muted, behind a "Skipping ad…" cover), handles ad pods,
  and recovers if the player ever wedges on an ad.
- Dismisses the anti-ad-blocker enforcement wall.
- Hides YouTube's own display ads — in-feed, masthead, and sidebar "Sponsored"
  cards — via structural selectors plus a heuristic "Sponsored"-badge scanner
  for formats YouTube hasn't shipped a known tag for yet.
- Optional **aggressive mode**: strips ad slots out of the player response so
  most ads never start (uBO-style json-prune). Off by default; a circuit
  breaker auto-disables it after repeated enforcement walls.

**Sponsor segments** — creator-read sponsor/self-promo/intro/outro segments,
skipped from three sources in order:
1. Creator "Ad Break" chapters (instant, deterministic).
2. [SponsorBlock](https://sponsor.ajay.app) crowd database — instant and exact,
   looked up by a hashed video-id prefix so the server never learns which video
   you watched.
3. AI transcript analysis — the fallback for videos with no SponsorBlock data
   (works on brand-new uploads). Picks which SponsorBlock categories to skip in
   options.

**Web ads & privacy**
- Ad + tracker blocking on every site via EasyList/AdGuard-derived
  `declarativeNetRequest` filter lists + cosmetic hiding, with per-site pause.
- Optional lists: cookie notices, social widgets, popups.
- **URL tracking-param stripping** (utm_, fbclid, gclid, and hundreds more).
- **Local-only mode**: forces on-device AI, disables diagnostics, and makes
  zero external network calls.

**YouTube extras** — hide Shorts, hide end-screen cards, turn off autoplay,
auto-dismiss the "Continue watching?" prompt.

**Self-healing** — when a YouTube DOM change breaks a hardcoded selector, the AI
re-finds the element and caches the fix; a gap-filler learns per-site ads the
filter lists miss.

## AI backends

Sponsor detection and the AI enhancements run on any of eight providers, with
automatic fallback to on-device AI if a key hits its rate limit:

| Provider | Setup | Notes |
| --- | --- | --- |
| **Chrome built-in AI** (default) | none | Gemini Nano via the Prompt API — free, on-device; needs Chrome 138+ |
| **Google Gemini** | free API key | |
| **Groq** | free API key | also used as the fast helper for small calls |
| **OpenRouter** | free API key | |
| **Local Ollama** | none | your local server |
| **OpenClaw gateway** | token + URL | your self-hosted gateway |
| **Anthropic Claude** | API key | |
| **OpenAI** | API key | |

`src/llm-client.ts` keeps the contract identical across providers:
`{"segments": [{start, end, type, confidence}]}` — validated on receipt, one
retry, then graceful degradation to ad-skipping only.

## Privacy

- Local-first: all blocking, analysis, and settings live in your browser.
- On-device AI by default — no key, no data leaves the machine.
- Transcripts go only to the AI provider you choose; SponsorBlock lookups use a
  hashed prefix; anonymous, scrubbed error/adaptation diagnostics are opt-out
  (and off entirely in local-only mode).

## Development

```sh
npm install
npm run build      # typecheck + production build to dist/
npm run dev        # vite dev server with HMR (crxjs)
npm run rulesets   # rebuild DNR filter rulesets from @adguard/dnr-rulesets
npm run package    # build + zip for distribution
```

### Load in Chrome

1. `npm run build`
2. Open `chrome://extensions`, enable **Developer mode**
3. **Load unpacked** → select the `dist/` directory
4. Open any YouTube video

## Architecture

```
src/
  selectors.ts        SINGLE source of truth for all YouTube DOM selectors
  types.ts            shared message/settings/stats contracts + defaults
  storage.ts          chrome.storage wrappers; caches, logs, healed selectors
  transcript.ts       transcript + chapter fetch/parse (content script)
  llm-client.ts       providers, prompts, JSON parsing/validation
  sponsorblock.ts     SponsorBlock hash-prefix lookup (service worker)
  net-blocker.ts      declarativeNetRequest ruleset enable/disable + counts
  prune-register.ts   registers the MAIN-world aggressive pruner at runtime
  error-reporting.ts  scrubbed, rate-limited error + event diagnostics
  changelog.ts        release notes shown in the popup "what's new" banner
  content/
    index.ts          content-script entry; SPA nav + engine lifecycle
    ad-engine.ts      YouTube ad detection, skipping, cloak, self-heal
    sponsor-engine.ts chapters → SponsorBlock → AI, timeupdate skip watcher
    cosmetic.ts       cross-site cosmetic ad hiding + YouTube ad selectors
    consent.ts        AI cookie-consent auto-reject
    popup-reviewer.ts AI-reviewed popup/overlay blocking
    youtube-annoyances.ts  Shorts / end cards / autoplay / idle prompt
    prune-loader.ts   isolated-world reporter for the aggressive pruner
    toast.ts          in-player "Skipped sponsor / Unskip" toast
  service-worker.ts   LLM orchestration, caching, counters, message routing
  popup/ options/ onboarding/ log/   extension pages
public/prune-main.js  MAIN-world json-prune (aggressive mode)
scripts/              ruleset build, zip packaging, version bump
.github/workflows/    monthly filter-list refresh → rebuild → (CWS publish)
landing/              marketing site (Vercel)
```

**Key invariants**

- Every YouTube DOM selector lives in `src/selectors.ts` — when YouTube ships a
  UI change, that's the first file to edit.
- The content script matches all of `youtube.com` (not just `/watch*`) because
  YouTube is an SPA; it gates itself to watch pages at runtime.
- The Sponsor Engine is strictly downstream of a validated JSON contract: if the
  LLM response doesn't parse, degrade to ad-skipping only — never break
  playback.
- Filter rulesets are static and shipped disabled; they're enabled at runtime
  and refreshed by shipping a new version (see the monthly GitHub Action).

## License

MIT — see [LICENSE](LICENSE). Bundled ad/tracker filter data is generated at
build time from AdGuard's DNR rulesets and retains its own upstream license.
