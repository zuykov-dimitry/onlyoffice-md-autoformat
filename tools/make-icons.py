#!/usr/bin/env python3
"""Generate plugin icons: dark rounded square with a white "M" and a cursor line."""

from PIL import Image, ImageDraw, ImageFont
import os

BASE = os.path.join(os.path.dirname(__file__), "..", "plugin", "resources")
BG = (30, 42, 50, 255)  # #1E2A32
FG = (255, 255, 255, 255)
ACCENT = (96, 205, 255, 255)  # markdown-ish blue accent


def rounded(draw, size, radius, fill):
    draw.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=fill)


def make(size, path):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    rounded(d, size, size // 5, BG)

    # "M" drawn as a polyline, scaled to the canvas
    pts = [
        (0.28, 0.72),
        (0.28, 0.30),
        (0.50, 0.58),
        (0.72, 0.30),
        (0.72, 0.72),
    ]
    w = max(2, size // 12)
    scaled = [(x * size, y * size) for x, y in pts]
    d.line(scaled, fill=FG, width=w, joint="curve")

    # cursor line under the M
    cy = 0.82
    d.line(
        [(0.26 * size, cy * size), (0.74 * size, cy * size)],
        fill=ACCENT,
        width=max(2, size // 16),
    )

    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path)


def main():
    scales = {"": 1.0, "@1.25x": 1.25, "@1.5x": 1.5, "@1.75x": 1.75, "@2x": 2.0}
    for theme in ("light", "dark"):
        for suffix, scale in scales.items():
            size = int(96 * scale)
            make(size, os.path.join(BASE, theme, f"icon{suffix}.png"))
    for suffix, scale in scales.items():
        size = int(96 * scale)
        make(size, os.path.join(BASE, "store", "icons", f"icon{suffix}.png"))
    print("icons done")


if __name__ == "__main__":
    main()
