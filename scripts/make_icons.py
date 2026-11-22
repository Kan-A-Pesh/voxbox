"""Renders the VoxBox pixel-art app icon (12x12 mic) to src-tauri/icons."""
from pathlib import Path

from PIL import Image

MIC = [
    "....####....",
    "...######...",
    "...##..##...",
    "...######...",
    "...##..##...",
    "...######...",
    ".#.######.#.",
    ".#..####..#.",
    "..##....##..",
    "....####....",
    ".....##.....",
    "...######...",
]
INK, VIOLET, CREAM = (6, 8, 26, 255), (185, 166, 255, 255), (244, 239, 226, 255)


def render(size: int) -> Image.Image:
    grid = 16  # 12x12 mic + 2 cell ink margin
    img = Image.new("RGBA", (grid, grid), INK)
    for y, row in enumerate(MIC):
        for x, c in enumerate(row):
            if c == "#":
                img.putpixel((x + 2, y + 2), VIOLET)
    # 1-cell cream frame keeps the icon readable on dark taskbars.
    for i in range(grid):
        for p in ((i, 0), (i, grid - 1), (0, i), (grid - 1, i)):
            img.putpixel(p, CREAM)
    return img.resize((size, size), Image.NEAREST)


out = Path(__file__).resolve().parent.parent / "src-tauri" / "icons"
out.mkdir(parents=True, exist_ok=True)
render(32).save(out / "32x32.png")
render(128).save(out / "128x128.png")
render(256).save(out / "icon.png")
render(256).save(out / "icon.ico", sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print("icons written to", out)
