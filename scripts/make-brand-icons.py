#!/usr/bin/env python3
"""Generate Ad Sensei extension icons per the v2 brand guidelines: the
"App Badge" form — a solid purple rounded tile with the white skip glyph
(two triangles + a bar). Drawn at high res and downscaled for crisp edges."""
from PIL import Image, ImageDraw

ACCENT = (124, 58, 237, 255)  # #7c3aed
WHITE = (255, 255, 255, 255)
SIZES = [16, 32, 48, 128]
SS = 16  # supersample factor

# Skip glyph geometry (viewBox-ish units): two right triangles + a stop bar.
GW, GH = 18.4, 14.0  # glyph width, height


def draw_badge(px: int) -> Image.Image:
    S = px * SS
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Rounded tile, near full-bleed with rounded (transparent) corners.
    radius = int(S * 0.22)
    d.rounded_rectangle([0, 0, S - 1, S - 1], radius=radius, fill=ACCENT)

    # Fit the glyph to ~58% of tile width, centered.
    target_w = S * 0.58
    scale = target_w / GW
    gw, gh = GW * scale, GH * scale
    ox = (S - gw) / 2
    oy = (S - gh) / 2

    def pt(x, y):
        return (ox + x * scale, oy + (y - 1.5) * scale)

    d.polygon([pt(0, 1.5), pt(6, 8.5), pt(0, 15.5)], fill=WHITE)
    d.polygon([pt(7.5, 1.5), pt(13.5, 8.5), pt(7.5, 15.5)], fill=WHITE)
    d.rectangle([pt(16, 1.5), pt(18.4, 15.5)], fill=WHITE)

    return img.resize((px, px), Image.LANCZOS)


for s in SIZES:
    draw_badge(s).save(f"src/icons/icon-{s}.png")
    print(f"wrote src/icons/icon-{s}.png ({s}px)")
