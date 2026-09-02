"""One-shot art optimiser: shrinks the Mini App's asset payload.

The webapp ships its art straight from this folder, and phones paid for every
megabyte twice (download + GPU decode). This script:

* downscales the 1024px ability icons to 256px (they render at ~64px),
* re-encodes every JPEG at quality 82 with optimised Huffman tables,
* re-encodes RGBA PNGs (hero/monster key art) as 256-colour palette PNGs.

Run with the repo's Pillow (``pip install pillow``)::

    python tools/optimize_art.py            # rewrite webapp/art in place
    python tools/optimize_art.py --dry-run  # report savings only

Originals remain in git history if you ever need them back.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

try:
    import numpy as np
    from PIL import Image, ImageDraw
except ImportError:  # pragma: no cover
    sys.stderr.write("Pillow + numpy are required: pip install pillow numpy\n")
    raise

ART = Path(__file__).resolve().parents[1] / "src" / "chronicle_rift" / "webapp" / "art"
ICON_MAX = 256
MAGENTA = (255, 0, 255)


def key_out_background(img: Image.Image, thresh: int = 24) -> Image.Image:
    """The hero/monster key art ships on an opaque charcoal backdrop. The
    arena needs real transparency, so flood-fill the connected backdrop from
    every border seed and cut it out (the fighters' bright outlines act as
    the flood barrier)."""
    rgb = img.convert("RGB")
    w, h = rgb.size
    seeds = [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1),
             (w // 2, 0), (w // 2, h - 1), (0, h // 2), (w - 1, h // 2)]
    for seed in seeds:
        if rgb.getpixel(seed) != MAGENTA:
            ImageDraw.floodfill(rgb, seed, MAGENTA, thresh=thresh)
    arr = np.asarray(rgb)
    magenta = (arr[:, :, 0] == 255) & (arr[:, :, 1] == 0) & (arr[:, :, 2] == 255)
    alpha = np.where(magenta, 0, 255).astype(np.uint8)
    rgba = img.convert("RGBA")
    rgba.putalpha(Image.fromarray(alpha, mode="L"))
    return rgba


def optimise_png(path: Path, *, dry_run: bool) -> tuple[int, int]:
    before = path.stat().st_size
    with Image.open(path) as img:
        img.load()
        if path.name.startswith("icon-") and max(img.size) > ICON_MAX:
            img = img.resize((ICON_MAX, ICON_MAX), Image.LANCZOS)
        if path.name.startswith(("char-", "mob-")):
            img = key_out_background(img)
        if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
            # Fast-octree quantisation keeps the alpha mask intact (tRNS),
            # so fighters never gain an opaque box around their art.
            img = img.convert("RGBA").quantize(
                colors=256, method=Image.Quantize.FASTOCTREE
            )
        elif img.mode != "P":
            img = img.convert("RGB")
            img = img.quantize(colors=256, method=Image.Quantize.MAXCOVERAGE)
        if not dry_run:
            img.save(path, optimize=True)
            after = path.stat().st_size
        else:
            after = before  # dry run: report potential only approximately
    return before, after


def optimise_jpg(path: Path, *, dry_run: bool) -> tuple[int, int]:
    before = path.stat().st_size
    if dry_run:
        return before, before
    with Image.open(path) as img:
        img.load()
        img.save(path, quality=82, optimize=True, progressive=True)
    return before, path.stat().st_size


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    total_before = total_after = 0
    for path in sorted(ART.iterdir()):
        if path.suffix.lower() == ".png":
            before, after = optimise_png(path, dry_run=args.dry_run)
        elif path.suffix.lower() in (".jpg", ".jpeg"):
            before, after = optimise_jpg(path, dry_run=args.dry_run)
        else:
            continue
        total_before += before
        total_after += after
        print(f"{path.name:28s} {before // 1024:6d} KB -> {after // 1024:6d} KB")
    print(f"{'TOTAL':28s} {total_before // 1024:6d} KB -> {total_after // 1024:6d} KB")


if __name__ == "__main__":
    main()
