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
- ⬜ **Phase 2 — Sponsor Engine**: transcript fetch, LLM segment detection,
  playback skip watcher, per-videoId caching.
- ⬜ **Phase 3 — Polish**: confidence slider, correction feedback, skip toast,
  options page.

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
  storage.ts          chrome.storage wrappers
  content/
    index.ts          content-script entry; SPA navigation + engine lifecycle
    ad-engine.ts      YouTube ad detection + skipping
  service-worker.ts   session counters; Phase 2: LLM calls + segment cache
  popup/              toggle UI + skip counters
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
