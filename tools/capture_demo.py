#!/usr/bin/env python3
"""Record ChronicleRift arena footage and screenshots with headless Chromium.

Usage (from the repository root, after `pip install playwright imageio imageio-ffmpeg`):

    python tools/capture_demo.py --out docs/assets

Serves the Mini App webapp on localhost, opens the demo harness, drives a
scripted duel and captures PNG frames that are assembled into docs/assets:
  - demo.gif   (inline README gameplay loop)
  - demo.mp4   (full-quality clip)
  - arena-*.png (stills of each hero / monster matchup)
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import io
import socket
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
WEBAPP = REPO / "src" / "chronicle_rift" / "webapp"


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


async def serve(directory: Path) -> tuple[asyncio.BaseServer, int]:
    port = free_port()

    class Handler(asyncio.Protocol):
        TYPES = {
            ".html": "text/html; charset=utf-8",
            ".js": "text/javascript; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".svg": "image/svg+xml",
        }

        def connection_made(self, transport):
            self.transport = transport

        def data_received(self, data):
            try:
                request = data.decode("utf-8", "replace").split("\r\n")[0]
                path = request.split(" ")[1].split("?")[0].lstrip("/")
                if path == "":
                    path = "index.html"
                file = (directory / path).resolve()
                if not str(file).startswith(str(directory.resolve())) or not file.is_file():
                    self.transport.write(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")
                    return
                body = file.read_bytes()
                ctype = self.TYPES.get(file.suffix, "application/octet-stream")
                head = (
                    f"HTTP/1.1 200 OK\r\nContent-Type: {ctype}\r\n"
                    f"Content-Length: {len(body)}\r\nCache-Control: no-store\r\n"
                    "Connection: close\r\n\r\n"
                ).encode()
                self.transport.write(head + body)
            except Exception:
                self.transport.write(
                    b"HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\n\r\n"
                )
            finally:
                self.transport.close()

    loop = asyncio.get_running_loop()
    server = await loop.create_server(Handler, "127.0.0.1", port)
    return server, port


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default="docs/assets", help="output directory")
    parser.add_argument("--fps", type=float, default=15.0, help="capture rate")
    parser.add_argument("--seconds", type=float, default=16.0, help="clip length")
    parser.add_argument("--still", action="store_true", help="also capture matchup stills")
    args = parser.parse_args()

    from playwright.async_api import async_playwright

    out_dir = REPO / args.out
    out_dir.mkdir(parents=True, exist_ok=True)
    server, port = await serve(WEBAPP)
    url = f"http://127.0.0.1:{port}/demo-harness.html"

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(
            args=[
                "--use-gl=angle",
                "--use-angle=swiftshader",
                "--enable-unsafe-swiftshader",
                "--disable-gpu-sandbox",
            ]
        )
        page = await browser.new_page(viewport={"width": 960, "height": 540})
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        await page.goto(url)
        await page.wait_for_function("window.__arena && window.__arena.player")

        uses3d = await page.evaluate("window.__arena.use3D")
        print(f"renderer 3D: {uses3d}")
        if not uses3d:
            print("WARNING: WebGL unavailable — falling back to 2D renderer")

        frames: list[bytes] = []
        # Deterministic stepping: the sim always advances at true game speed
        # (60 ticks/s) no matter how slow software rendering is, so the GIF
        # plays back at real speed.
        ticks_per_frame = max(1, round(60 / args.fps))
        total_frames = int(args.seconds * args.fps)

        # scene plan, three acts: opening duel → clash of opposites → boss finale
        plan = [
            (0, ("fire", "Ash Warden", "fire", "brute", 1.26)),
            (int(total_frames * 0.45), ("wind", "Frost Revenant", "ice", "brute", 1.3)),
            (int(total_frames * 0.75), ("shadow", "Ebon Colossus", "shadow", "brute", 1.5)),
        ]
        current = None

        await page.evaluate("window.__pause()")
        for index in range(total_frames):
            for at, setup in plan:
                if index == at:
                    current = setup
                    await page.evaluate(
                        "([h, n, e, b, s]) => window.__setup(h, n, e, b, s)", list(setup)
                    )
            ended = await page.evaluate("!!window.__ended")
            if ended and current:
                await page.evaluate(
                    "([h, n, e, b, s]) => window.__setup(h, n, e, b, s)", list(current)
                )
            data = await page.evaluate(
                "([n]) => window.__step(n, 1/60)", [ticks_per_frame]
            )
            frames.append(base64.b64decode(data.split(",", 1)[1]))
            if len(frames) % 40 == 0:
                print(f"  captured {len(frames)}/{total_frames} frames")

        js_errors = await page.evaluate("window.__errors")
        all_errors = errors + [e for e in js_errors if e]

        if args.still:
            matchups = [
                ("fire", "Rift Stalker", "shadow", "beast", 1.22, "arena-fire"),
                ("ice", "Frost Revenant", "ice", "brute", 1.3, "arena-ice"),
                ("wind", "Ash Warden", "fire", "brute", 1.26, "arena-wind"),
                ("arcane", "Obsidian Herald", "arcane", "brute", 1.3, "arena-arcane"),
                ("shadow", "Ebon Colossus", "shadow", "brute", 1.5, "arena-boss"),
            ]
            for hero_el, name, el, build, scale, slug in matchups:
                await page.evaluate(
                    "([h, n, e, b, s]) => window.__setup(h, n, e, b, s)",
                    [hero_el, name, el, build, scale],
                )
                await page.evaluate("([n]) => window.__step(n, 1/60)", [round(2.2 * 60)])
                data = await page.evaluate(
                    "([n]) => window.__step(n, 1/60)", [round(0.8 * 60)]
                )
                (out_dir / f"{slug}.png").write_bytes(base64.b64decode(data.split(",", 1)[1]))
                print(f"  still: {slug}.png")

        await browser.close()
    server.close()

    if all_errors:
        print("JS ERRORS DURING CAPTURE:")
        for e in all_errors[:20]:
            print("  -", e)
        return 2

    # assemble the deliverables:
    #   demo.mp4 — full clip at 576x320 (16:9, macro-block clean)
    #   demo.gif — inline README loop, trimmed and palette-reduced to stay light
    from PIL import Image

    mp4_frames = []
    for raw in frames:
        img = Image.open(io.BytesIO(raw)).convert("RGB")
        mp4_frames.append(img.resize((576, 320), Image.LANCZOS))
    try:
        import imageio.v3 as iio
    except Exception:
        print("imageio not installed — skipped mp4/gif assembly")
        return 0
    mp4_path = out_dir / "demo.mp4"
    iio.imwrite(
        mp4_path,
        [f for f in mp4_frames],
        fps=int(args.fps),
        codec="libx264",
        quality=7,
        macro_block_size=16,
    )
    print(f"wrote {mp4_path} ({mp4_path.stat().st_size / 1e6:.1f} MB)")

    gif_source = mp4_frames[10:] if len(mp4_frames) > 40 else mp4_frames
    pil_frames = [
        f.resize((448, 252), Image.LANCZOS).convert("P", palette=Image.ADAPTIVE, colors=96)
        for f in gif_source
    ]
    gif_path = out_dir / "demo.gif"
    pil_frames[0].save(
        gif_path,
        save_all=True,
        append_images=pil_frames[1:],
        duration=int(1000 / args.fps),
        loop=0,
        optimize=True,
    )
    print(f"wrote {gif_path} ({gif_path.stat().st_size / 1e6:.1f} MB, {len(pil_frames)} frames)")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
