# Ad Sensei — Design System

The visual language of the Ad Sensei extension, codified so any surface
(landing page, store listing, marketing, Figma, another build) stays
consistent with the product. Values are extracted from the shipping extension
UI (`src/popup`, `src/options`), not invented.

Use this document as-is: paste it as instructions to a design tool, hand it to
a designer, or feed it to a build. Every token below is real and in use.

---

## 1. Brand

- **Name:** Ad Sensei (internal package: `skip-sensei`)
- **Mascot / logo:** a purple zen-circle enclosing a fast-forward / skip glyph
  (▶▶▎). Rounded, bold, high-contrast — reads at 16px. Transparent background.
- **One-liner:** "Skip YouTube ads and creator sponsor segments, and block ads
  & trackers across the web."
- **Personality:** calm, capable, quietly powerful. A sensei — it handles the
  interruptions so you don't have to think about them. Not loud, not "hacker",
  not corporate. Confident and unobtrusive.
- **Positioning cues to lean on:** AI-powered (transcript AI, self-healing),
  private (client-side, no backend), free (built-in AI default), effortless
  (zero interaction).

---

## 2. Color

Semantic tokens with light + dark values. The product ships dark-first (it
lives next to YouTube's dark UI) but supports both via `prefers-color-scheme`.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--accent` | `#7c3aed` | `#7c3aed` | **Brand purple.** Primary actions, active toggles, highlights, links-as-brand. Constant across themes. |
| `--bg` | `#ffffff` | `#212121` | Page / surface background |
| `--text` | `#0f0f0f` | `#f1f1f1` | Primary text |
| `--text-2` | `#606060` | `#aaaaaa` | Secondary / muted text, captions |
| `--divider` | `rgba(0,0,0,.1)` | `rgba(255,255,255,.12)` | Hairline borders, section separators |
| `--hover` | `rgba(0,0,0,.05)` | `rgba(255,255,255,.08)` | Row / button hover fills |
| `--link` | `#065fd4` | `#3ea6ff` | Inline text links (YouTube-blue, distinct from brand purple) |

**Accent scale** (derive from `#7c3aed` when you need variants):
- Hover/active: `brightness(1.1)` on the accent.
- Tinted fills: `color-mix(in srgb, #7c3aed 50%, transparent)` (used for the
  "on" toggle track).
- Deep marketing background option: near-black `#0f0f13`–`#16121f` with purple
  glow, matching the mascot's dark presentation.

**Rules**
- Purple is the *only* saturated color. Everything else is neutral. Don't
  introduce a second brand hue.
- Link-blue (`--link`) is for text links only — never confuse it with the
  purple accent.
- Maintain WCAG AA contrast: `--text` on `--bg`, and white on `--accent`
  (#7c3aed passes for large/medium text and UI).

---

## 3. Typography

- **Family:** `Roboto, Arial, "Helvetica Neue", sans-serif` (YouTube's face).
  For a landing page, Roboto (or Inter as a close fallback) keeps the kinship.
- **Weights:** 400 (body), 500 (labels, emphasis), 700 (stats, key numbers).
- **Antialiasing:** `-webkit-font-smoothing: antialiased`.

**Type scale (from the product)**
| Role | Size | Weight |
| --- | --- | --- |
| Display / hero | 26–40px | 500–700 |
| H1 (surface title) | 20px | 500 |
| H2 (section) | 15–16px | 500 |
| Body | 13–14px | 400 |
| Label | 14px | 500 |
| Caption / secondary | 11–13px | 400 |
| Micro (section eyebrow) | 10–11px, uppercase, `letter-spacing: .08em` | 500 |
| Numeric (stats) | tabular-nums, 700 |

---

## 4. Spacing, radius, elevation

- **Spacing:** 4 / 6 / 8 / 12 / 16 / 24 / 32px. Section padding 24px; row
  padding 8×16px; tight rows 6×16px.
- **Radius:** 6px (small controls, chips), 8px (inputs, buttons, cards),
  10–12px (larger cards / panels), 18px (pill buttons), 50% (toggle knob,
  mascot circle).
- **Elevation:** flat by default, separated by `--divider` hairlines. Only
  floating elements (tooltips, snackbar, toast) get shadow:
  `0 4px 16px rgba(0,0,0,.3)`.

---

## 5. Components

**Toggle switch (Material / YouTube style)**
- 34×20px; thin track (14px tall, 7px radius) with an overlapping 20px round
  knob that has a soft shadow.
- Off: `--track` neutral. On: track = 50% accent tint, knob = solid `--accent`.
- Focus-visible: 2px `--link` outline offset 2px.

**Pill button**
- Height 36px, radius 18px, weight 500. Neutral (`--hover` fill) for secondary;
  solid `--accent` + white text for primary. Hover brightens.

**Info tooltip (ⓘ)**
- Small muted ⓘ next to a label; hovers to brand color. On hover/focus shows a
  rounded bubble (inverted surface: `--text` bg / `--bg` text), 11–12px, with
  the shadow above. Keyboard-focusable. Anchored so it never overflows.
- Principle: **labels stay short; detail lives in the tooltip.**

**Card**
- 1px `--divider` border, 10–12px radius, 16px padding. No fill, no shadow
  (flat). For numbered feature cards, a 28px round accent badge with the index.

**Section eyebrow + separator**
- Uppercase micro label in `--text-2`, followed by content, closed by a
  `--divider` hairline. This is the primary way sections are delineated.

**Snackbar / toast**
- Inverted surface (dark-on-light in light mode, light-on-dark in dark),
  8px radius, shadow, bottom-anchored. Brief, non-blocking.

**Inputs**
- 40px tall, 8px radius, subtle fill (`--field-bg`), 1px `--divider` border →
  `--link` border on focus. `accent-color: --accent` for native checkbox/range.

---

## 6. Iconography

- Line/solid hybrid, rounded, bold enough to read small. The skip/fast-forward
  glyph (▶▶) and the zen circle are the signature marks.
- Purple as the icon accent; neutral for secondary glyphs.
- Reuse the mascot as the primary brand mark everywhere (favicon, hero, store).

---

## 7. Voice & tone

- **Plain, complete sentences.** Explain what happens, not jargon.
- **Confident, not hypey.** "Skips YouTube ads automatically." Not "🚀
  Supercharge your browsing!!"
- **Lead with the benefit, tuck the mechanism into a tooltip / secondary line.**
- **Honest about tradeoffs** (e.g. built-in AI is slower on long videos). Trust
  is part of the brand.
- Sentence case for UI and headings, not Title Case.

---

## 8. Landing-page application (quick brief)

If building marketing from this system:
- **Dark hero**, near-black with a purple glow behind the mascot; the one-liner
  as the headline; a single primary pill CTA in `--accent`.
- **Three feature blocks** mirroring the three engines (Skip YouTube ads /
  Skip sponsor segments / Block ads across the web) — flat cards, numbered
  accent badges, benefit-first copy.
- **A "why it's different" band:** transcript-AI moat, self-healing, fully
  client-side/private, free by default.
- Keep it one saturated color (purple), everything else neutral. Flat surfaces,
  hairline dividers, generous spacing. Roboto/Inter. Light+dark aware.
- CTA target is a placeholder until the Chrome Web Store listing exists.
