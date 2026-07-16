# Chrome Web Store listing assets

Store screenshots and the small promo tile for the Ad Sensei CWS listing.
Branded feature tiles (not raw UI captures), built from HTML and rendered with
headless Chrome at 2× then downscaled for crisp text.

## Files

| File | Size | Use |
|---|---|---|
| `1-hero.png` | 1280×800 | Screenshot — "Skip the ad. Every ad." (AI-forward hero) |
| `2-three-layers.png` | 1280×800 | Screenshot — "One ad blocker, three layers" |
| `3-youtube.png` | 1280×800 | Screenshot — instant YouTube ad skipping |
| `4-alt-sponsor-timeline.png` | 1280×800 | Screenshot — AI sponsor-segment skip (timeline) |
| `5-ai.png` | 1280×800 | Screenshot — "AI where filter lists can't reach" |
| `6-private.png` | 1280×800 | Screenshot — "Powerful. Private. Free." |
| `promo-tile-440x280.png` | 440×280 | Small promo tile (search/category results) |

Screenshots are 1280×800 (CWS's preferred size). **A CWS listing accepts at
most 5 screenshots**, so pick 5 of the six 1280×800 tiles at upload time — the
sponsor timeline (`4-`) and the AI grid (`5-`) overlap, so they're the natural
either/or.

## Regenerating

The five composed slides come from `gen.mjs`; the promo tile is `promo.html`.
To rebuild:

```
node gen.mjs <output-dir>          # writes slide-1.html … slide-6.html
# render each at --window-size=1280,800 --force-device-scale-factor=2,
# then downscale to 1280×800 (e.g. `sips -z 800 1280`). promo.html uses 440×280.
```

Brand: Roboto / Roboto Mono, `#7c3aed` purple, two-tone Ad Sensei wordmark and
skip-glyph — matched to `landing/index.html`.
