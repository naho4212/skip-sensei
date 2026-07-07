# skip-sensei

Chrome extension (Manifest V3) that automatically skips all interruptions in
YouTube videos: YouTube-served ads and, in Phase 2, creator-read sponsor
segments detected by LLM analysis of the video transcript.

> **Naming:** the public/store name is **Ad Sensei** and appears only in
> `manifest.config.ts` (plus store listing/assets). Everything in code —
> package name, storage keys, namespaces — is `skip-sensei` / `skipSensei`,
> so a store-driven rebrand never touches the code.

## Status

- ✅ **Phase 1 — Ad Engine**: skip-button clicking, un-skippable-ad
  fast-forward, overlay/banner removal, pause-screen ad dismissal, SPA
  re-attach, popup with toggles + skip counters.
- ✅ **Phase 2 — Sponsor Engine**: transcript fetch (timedtext json3 + XML
  fallback), LLM segment detection with a strict JSON contract, per-videoId
  caching, playback skip watcher, status UI.
- ✅ **Phase 3 — Polish**: confidence slider, skip toast with
  "Unskip" correction feedback, options page, live-stream/short-video
  edge cases.

## LLM backends (hybrid)

Consumer Claude/ChatGPT logins can't power third-party apps (ToS), so the
Sponsor Engine supports:

| Provider | Setup | Notes |
| --- | --- | --- |
| **Chrome built-in AI** (default) | none | Gemini Nano via the Prompt API, free + on-device; needs Chrome 138+, downloads the model on first use |
| **Anthropic Claude** | API key in options | default model `claude-haiku-4-5` |
| **OpenAI** | API key in options | default model `gpt-5-mini` |

`src/llm-client.ts` keeps the contract identical across providers:
`{"segments": [{start, end, type, confidence}]}` — validated on receipt,
one retry, then graceful degradation to ad-skipping only.

## Development

```sh
npm install
npm run build     # typecheck + production build to dist/
npm run dev       # vite dev server with HMR (crxjs)
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
  types.ts            shared message/settings/stats contracts
  storage.ts          chrome.storage wrappers; analysis cache + corrections log
  transcript.ts       transcript fetch + parse (runs in content script for cookies)
  llm-client.ts       prompt construction, providers, JSON parsing/validation
  builtin-ai.d.ts     ambient types for Chrome's Prompt API (Gemini Nano)
  content/
    index.ts          content-script entry; SPA navigation + engine lifecycle
    ad-engine.ts      YouTube ad detection + skipping
    sponsor-engine.ts segment fetch + timeupdate skip watcher
    toast.ts          in-player "Skipped sponsor / Unskip" toast
  service-worker.ts   LLM orchestration, segment cache, session counters
  popup/              toggle UI, skip counters, per-video status
  options/            provider/API key, confidence slider, toast toggle
```

**Key invariants**

- Every YouTube DOM selector lives in `src/selectors.ts` — when YouTube ships
  a UI change, that's the one file to edit.
- The content script matches all of `youtube.com` (not just `/watch*`)
  because YouTube is an SPA; it gates itself to watch pages at runtime and
  re-initializes on `yt-navigate-finish`.
- Phase 2 rule: the Sponsor Engine is strictly downstream of a validated JSON
  contract. If the LLM response doesn't parse, degrade to ad-skipping only —
  never break playback.
