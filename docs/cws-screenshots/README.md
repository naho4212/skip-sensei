# Chrome Web Store listing assets

Store screenshots and the small promo tile for the Ad Sensei CWS listing.
Branded feature tiles (not raw UI captures), built from HTML and rendered with
headless Chrome at 2× then downscaled for crisp text.

## Files

| File | Size | Use |
|---|---|---|
| `1-hero.png` | 1280×800 | Screenshot — "Skip the ad. Every ad." (AI-forward hero) |
| `2-youtube-sponsor.png` | 1280×800 | Screenshot — YouTube ads + AI sponsor-skip (player + timeline) |
| `3-web-blocking.png` | 1280×800 | Screenshot — "Block ads on every site" (lists + AI gap-filler) |
| `4-ai-private.png` | 1280×800 | Screenshot — "Smart. Private. Free." (AI + privacy) |
| `5-popup.png` | 1280×800 | Screenshot — the real popup UI ("This site" view) |
| `promo-tile-440x280.png` | 440×280 | Small promo tile (search/category results) |
| `marquee-1400x560.png` | 1400×560 | Marquee promo tile (required for the automated Featured-badge check — an empty slot disqualifies) |

Screenshots are 1280×800 (CWS's preferred size), exactly five — CWS's maximum —
uploaded in file order, and every tile carries the AI thread where it's real.
Upload directly from this directory (the old `~/Desktop/cws-screenshots/submit/`
staging copy no longer exists).
The popup tile mirrors the real `entrypoints/popup` "This site" view — keep it
in sync if the popup UI changes materially.

## Regenerating

The five composed slides come from `gen.mjs`; the promo tile is `promo.html`.
To rebuild:

```
node gen.mjs <output-dir>          # writes slide-1.html … slide-6.html
# render each at --window-size=1280,800 --force-device-scale-factor=2,
# then downscale to 1280×800 (e.g. `sips -z 800 1280`). promo.html uses 440×280;
# marquee.html uses 1400×560 (render 2×, then `sips -z 560 1400`).
```

Brand: Roboto / Roboto Mono, `#7c3aed` purple, two-tone Ad Sensei wordmark and
skip-glyph — matched to `landing/index.html`.
