#!/usr/bin/env python3
"""Crop the source icon art to the mascot's bounds (transparent bg) and emit
the extension icon sizes. Re-run whenever the source art changes."""
import sys
from PIL import Image

SRC = sys.argv[1] if len(sys.argv) > 1 else "/Users/nathan/Desktop/image.png"
OUT_DIR = "src/icons"
SIZES = [16, 32, 48, 128]
# Fraction of the tight bounding box added as breathing room on each side.
MARGIN = 0.06

img = Image.open(SRC).convert("RGBA")
w, h = img.size
px = img.load()

# Sample the four corners to learn the background color, then treat pixels
# close to it (or fully transparent) as background.
corners = [px[0, 0], px[w - 1, 0], px[0, h - 1], px[w - 1, h - 1]]
bg = tuple(sum(c[i] for c in corners) // 4 for i in range(3))


def is_bg(p):
    if p[3] < 16:
        return True
    return all(abs(p[i] - bg[i]) < 32 for i in range(3))


# Tight bounding box of foreground pixels.
minx, miny, maxx, maxy = w, h, 0, 0
for y in range(h):
    for x in range(w):
        if not is_bg(px[x, y]):
            minx, miny = min(minx, x), min(miny, y)
            maxx, maxy = max(maxx, x), max(maxy, y)

bw, bh = maxx - minx, maxy - miny
mx, my = int(bw * MARGIN), int(bh * MARGIN)
minx, miny = max(0, minx - mx), max(0, miny - my)
maxx, maxy = min(w, maxx + mx), min(h, maxy + my)

# Knock out the background to transparency so there's no box around the icon.
cropped = img.crop((minx, miny, maxx, maxy))
cpx = cropped.load()
for y in range(cropped.height):
    for x in range(cropped.width):
        if is_bg(cpx[x, y]):
            cpx[x, y] = (0, 0, 0, 0)

# Center on a transparent square canvas.
side = max(cropped.size)
canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
canvas.paste(
    cropped,
    ((side - cropped.width) // 2, (side - cropped.height) // 2),
    cropped,
)

for s in SIZES:
    canvas.resize((s, s), Image.LANCZOS).save(f"{OUT_DIR}/icon-{s}.png")
    print(f"wrote {OUT_DIR}/icon-{s}.png")
