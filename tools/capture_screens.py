#!/usr/bin/env python3
"""Screenshot the Mini App UI (home, heroes, profile) with a stubbed API.

Serves the webapp statically, fakes /api/me with a freshly generated player
view, and captures PNG screenshots into docs/assets. Also a full UI smoke
test: any console or page error fails the run.

Usage: python tools/capture_screens.py --out docs/assets
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "src"))

from capture_demo import serve  # noqa: E402

from chronicle_rift.models import new_player, public_player_view  # noqa: E402


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default="docs/assets")
    args = parser.parse_args()

    from playwright.async_api import async_playwright

    player = new_player(user_id=11, first_name="Rita", username="riftwalkrita")
    player["game"]["coins"] = 860
    me = {"player": public_player_view(player), "version": "0.13.0"}
    payload = json.dumps(me)

    out_dir = REPO / args.out
    out_dir.mkdir(parents=True, exist_ok=True)
    server, port = await serve(REPO / "src" / "chronicle_rift" / "webapp")

    errors: list[str] = []
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(
            args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
        )
        page = await browser.new_page(viewport={"width": 430, "height": 820}, device_scale_factor=2)
        page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
        page.on(
            "console",
            lambda m: errors.append(f"console: {m.text}") if m.type == "error" else None,
        )
        await page.route("**/api/me", lambda route: route.fulfill(
            status=200, content_type="application/json", body=payload
        ))
        await page.goto(f"http://127.0.0.1:{port}/index.html")
        # skip the onboarding modal for screenshots
        await page.evaluate("localStorage.setItem('cr_tutorial_v7', '1')")
        await page.reload()
        await page.wait_for_selector("#home-char-name")
        await page.wait_for_timeout(900)
        await page.screenshot(path=str(out_dir / "ui-home.png"))

        # heroes store with the damage/effect lines
        await page.click("[data-goto='heroes']")
        await page.wait_for_timeout(700)
        await page.screenshot(path=str(out_dir / "ui-heroes.png"))

        # powers screen with trained levels (from home)
        await page.click("#screen-store [data-goto='home']")
        await page.wait_for_timeout(500)
        await page.click(".home-tile[data-goto='powers']")
        await page.wait_for_timeout(700)
        await page.screenshot(path=str(out_dir / "ui-powers.png"))
        powers = await page.locator("#power-list .power-card .power-level").all_text_contents()
        print("power levels:", powers)
        assert len(powers) == 4, "powers screen cards missing"
        await page.click("#screen-powers [data-goto='home']")
        await page.wait_for_timeout(500)

        # profile
        await page.click("#topbar-profile")
        await page.wait_for_timeout(700)
        await page.screenshot(path=str(out_dir / "ui-profile.png"))

        # settings with the graphics picker — go home first, then the More tile
        await page.click("#screen-profile [data-goto='home']")
        await page.wait_for_timeout(500)
        await page.click(".home-tile[data-goto='settings']")
        await page.wait_for_timeout(500)
        await page.screenshot(path=str(out_dir / "ui-settings.png"))
        modes = await page.locator(".gfx-picker button").all_text_contents()
        print("graphics modes:", modes)
        assert [m.strip().lower() for m in modes] == ["auto", "3d", "2d"], "graphics picker missing"

        # sanity: the hero shop shows damage numbers, not cooldowns
        moves = await page.locator(".hero-moves span").all_text_contents()
        print("ability lines sample:", moves[:6])
        assert moves and all("CD" not in m for m in moves), "cooldowns still shown in hero shop"
        assert any("DMG" in m for m in moves), "damage estimates missing from hero shop"
        await browser.close()
    server.close()

    if errors:
        print("UI ERRORS:")
        for e in errors[:20]:
            print("  -", e)
        return 2
    print("UI smoke test passed; screenshots written to", out_dir)
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
