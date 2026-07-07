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
- **Phase 4 — General ad blocking (MVP)**: `declarativeNetRequest` + `<all_urls>`,
  prebuilt MV3 filter rulesets (EasyList/EasyPrivacy), "Block all ads" toggle,
  reload-to-apply. Outcome: ~90% network ad blocking across the web.
- **Phase 5 — Per-site control + allowlist**: current-site status, "Pause on this
  site", managed allowlist (dynamic allow rules), per-page blocked counter.
- **Phase 6 — Cosmetic filtering**: content-script element hiding, extended
  selectors, optional toggle.
- **Phase 7 — Filter-list management**: list versions/dates, manual update,
  optional extra lists.
- **Phase 8 — AI enhancements (differentiator)**: self-healing selectors
  (YouTube ad + transcript path), AI gap-filler for ads filter lists miss
  (per-domain cached hiding rules), behind AI toggle.
- **Phase 9 — Unify + harden + store-safe build**: one stats surface,
  onboarding, perf pass, store-safe variant (strip anti-adblock wall dismissal).

## Decisions

- AI enhancement defaults **off** (free/instant blocker out of the box; AI is a
  power-user upgrade).
- Popup restructures into "Blocking" (toggles) + "This site" (pause/counter)
  sections as the toggle count grows.
- General ad blocking is a CWS-permitted category; the anti-adblock wall
  dismissal is the store-risky piece to gate/remove for any store build.
