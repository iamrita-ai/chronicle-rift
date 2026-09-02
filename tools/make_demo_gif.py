"""Compose docs/gameplay.gif — a looping arena duel built from the REAL
hero/monster key art, so the README shows exactly what the fighters look
like in game. Pure Pillow; deterministic.

    python tools/make_demo_gif.py
"""

from __future__ import annotations

import math
import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
ART = ROOT / "src" / "chronicle_rift" / "webapp" / "art"
OUT = ROOT / "docs" / "gameplay.gif"

W, H = 480, 270
FPS_MS = 70
FRAMES = 26


def crop_char(path: Path) -> Image.Image:
    with Image.open(path) as img:
        img = img.convert("RGBA")
        return img.crop(img.getbbox())


def fit(img: Image.Image, height: int) -> Image.Image:
    scale = height / img.height
    return img.resize((max(1, int(img.width * scale)), height), Image.LANCZOS)


def font(size: int) -> ImageFont.FreeTypeFont:
    for candidate in (
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
    ):
        if Path(candidate).exists():
            return ImageFont.truetype(candidate, size)
    return ImageFont.load_default()


def main() -> None:
    random.seed(7)
    hero = fit(crop_char(ART / "char-emberblade.png"), 150)
    mob = fit(crop_char(ART / "mob-ash-warden.png"), 160)
    mob_flash = mob.copy()
    overlay = Image.new("RGBA", mob.size, (255, 255, 255, 0))
    overlay.putalpha(mob.split()[3])
    mob_flash = Image.alpha_composite(mob, overlay)

    frames: list[Image.Image] = []
    f_title = font(15)
    f_small = font(10)

    for i in range(FRAMES):
        img = Image.new("RGBA", (W, H), (10, 8, 14, 255))
        d = ImageDraw.Draw(img)
        # ember backdrop glow
        for gx, gy, gr, gc in ((90, 210, 90, (60, 25, 10)), (400, 200, 110, (45, 18, 22))):
            for r in range(gr, 0, -6):
                a = int(26 * r / gr)
                d.ellipse((gx - r, gy - r, gx + r, gy + r), fill=(*gc, a))
        # ground
        d.rectangle((0, 218, W, H), fill=(16, 12, 18, 255))
        d.ellipse((40, 214, 440, 236), fill=(26, 18, 24, 255))
        d.ellipse((60, 217, 420, 231), outline=(255, 138, 60, 90), width=2)

        shake = 0
        flash_mob = 0
        hero_x, mob_x = 92, 300
        num_alpha = 0

        if i < 7:  # idle breathing
            bob = math.sin(i * 0.9) * 2
            hero_y = 218 - hero.height + bob
            mob_y = 218 - mob.height + math.sin(i * 0.9 + 2) * 2
        elif i < 11:  # hero lunges
            k = (i - 7) / 3
            hero_x = 92 + k * 96
            hero_y = 218 - hero.height + 2
            mob_y = 218 - mob.height
        elif i < 17:  # impact: flash, knockback, shake, damage number
            k = i - 11
            flash_mob = 1 if k < 2 else 0
            mob_x = 300 + k * 9
            hero_x = 188 - k * 3
            hero_y = 218 - hero.height
            mob_y = 218 - mob.height - (4 if k < 3 else 0)
            shake = 4 - k // 2
            num_alpha = 255 - k * 30
        else:  # settle + victory bounce
            k = i - 17
            hero_y = 218 - hero.height - abs(math.sin(k * 0.8)) * 8
            mob_y = 218 - mob.height
            mob_x = 354

        sx = random.randint(-shake, shake) if shake else 0
        sy = random.randint(-shake // 2, shake // 2) if shake else 0

        # fighters (mob mirrored to face the hero)
        drawn_mob = mob_flash if flash_mob else mob
        img.paste(drawn_mob, (int(mob_x) + sx, int(mob_y) + sy), drawn_mob)
        img.paste(hero, (int(hero_x) + sx, int(hero_y) + sy), hero)

        if 11 <= i < 15:  # slash arc
            d.arc((250, 120, 350, 220), -60, 40, fill=(255, 212, 121, 220), width=4)
        if 11 <= i < 17 and num_alpha > 0:  # damage number
            d.text((312, 92), "-38", font=f_title, fill=(255, 122, 134, num_alpha))
        for _ in range(3 if 11 <= i < 14 else 1):  # sparks
            px, py = random.randint(280, 340), random.randint(130, 200)
            d.ellipse((px, py, px + 3, py + 3), fill=(255, 176, 102, 200))

        # HUD: names + HP bars
        d.rectangle((12, 10, 190, 20), fill=(30, 22, 26, 255))
        hp_hero = 1.0
        d.rectangle((12, 10, 12 + 178 * hp_hero, 20), fill=(142, 240, 168, 255))
        d.text((14, 24), "Emberblade", font=f_small, fill=(255, 255, 255, 230))
        d.rectangle((W - 190, 10, W - 12, 20), fill=(30, 22, 26, 255))
        hp_mob = 1.0 if i < 12 else max(0.25, 1.0 - (i - 11) * 0.09)
        d.rectangle((W - 12 - 178 * hp_mob, 10, W - 12, 20), fill=(255, 95, 109, 255))
        d.text((W - 96, 24), "Ash Warden", font=f_small, fill=(255, 255, 255, 230))
        d.text((W // 2 - 60, H - 18), "CHRONICLERIFT — RIFT ARENA", font=f_small,
               fill=(255, 255, 255, 120))

        frames.append(img.convert("P", palette=Image.ADAPTIVE, colors=128))

    OUT.parent.mkdir(parents=True, exist_ok=True)
    frames[0].save(
        OUT, save_all=True, append_images=frames[1:], duration=FPS_MS, loop=0, optimize=True
    )
    print(f"wrote {OUT} ({OUT.stat().st_size // 1024} KB, {FRAMES} frames)")


if __name__ == "__main__":
    main()
