# Ad Sensei / skip-sensei — Roadmap

Three "what to block" capabilities, each independently useful:

| Capability | Mechanism | Nature | Status |
| --- | --- | --- | --- |
| Skip YouTube ads | reactive skip-button + fast-forward | per-video, runtime | ✅ |
| Skip sponsor segments | transcript AI | per-video, runtime | ✅ |
| Block all ads (web) | filter lists → `declarativeNetRequest` + cosmetic | network-level, whole web | Phase 4+ |

## Control surface

**"What to block" toggles:** master, Skip YouTube ads, Skip sponsor segments, Block all ads.

**General-blocker controls:**
- Per-site allowlist / "Pause on this site" (popup one-click + managed list in options)
- Reload-to-apply affordance (network rules only affect new requests)
- Filter-list status + manual update
- Per-page block counter
- AI enhancement toggle (self-healing + gap-filler; default off — spends tokens)
- Cosmetic filtering toggle (optional/advanced)

**Existing:** confidence threshold, LLM provider/key, skip toast, clear cache.

## Phases

- **Phase 1 — YouTube Ad Engine** (reactive skip) ✅
- **Phase 2 — Sponsor Engine** (transcript AI) ✅
- **Phase 3 — Polish** (options, toast, stats, icon, per-provider keys, Gemini) ✅
- **Phase 4 — General ad blocking (MVP)** ✅: `declarativeNetRequest` (no host
  perm needed — block-only rules), prebuilt MV3 filter rulesets (AdGuard Base +
  Mobile Ads, ~70k rules), "Block all ads" toggle, runtime enable with
  rule-limit error handling, reload-to-apply. ~90% network ad blocking.
- **Phase 5 — Per-site control + allowlist** ✅: current-site section in popup,
  "Pause ad blocking here" toggle (dynamic allowAllRequests rules), managed
  allowlist in options, per-page blocked counter (under Sponsor segments).
- **Phase 6 — Cosmetic filtering** ✅: content-script (`cosmetic.ts`, all_urls,
  document_start) hides ad containers via curated high-signal selectors;
  gated on blockAllAds + allowlist. Catches first-party banners + leftover ad
  boxes network blocking can't. (Adds the all-sites content-script permission.)
- **Phase 7 — Filter-list management**: list versions/dates, manual update,
  optional extra lists.
- **Phase 8 — AI enhancements (differentiator)** ✅ (self-healing): when no
  known skip-button selector matches during an ad, the AI is sent the player
  controls and re-finds the button; validated (must match a visible element),
  cached, and added to the runtime selector list so the fix persists. Behind
  the `aiEnhancements` toggle (default on; free on built-in AI). AI gap-filler
  for missed web ads is still open.
- **Phase 9 — Unify + harden** ✅ (personal-use scope): first-run onboarding
  page (3 engines + built-in-vs-Gemini), unified stats (web-ads-blocked row),
  console noise gated behind a debugLogging setting (off by default, toggle in
  options). Store-safe variant intentionally skipped — personal use only; the
  anti-adblock wall dismissal stays. AI web-ad gap-filler still open.

## Decisions

- AI enhancement defaults **off** (free/instant blocker out of the box; AI is a
  power-user upgrade).
- Popup restructures into "Blocking" (toggles) + "This site" (pause/counter)
  sections as the toggle count grows.
- General ad blocking is a CWS-permitted category; the anti-adblock wall
  dismissal is the store-risky piece to gate/remove for any store build.
