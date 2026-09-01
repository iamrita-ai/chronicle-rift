"""Local, database-free preview of the ChronicleRift Mini App.

Runs the REAL game engine in memory and serves the REAL Mini App files, with a
stubbed ``window.Telegram`` object so the UI can be played in a plain browser.

    python tools/preview_miniapp.py           # then open http://localhost:8080

This is a development tool only: no Telegram authentication, no MongoDB, no AI
narration. Never deploy it.
"""

from __future__ import annotations

import json
import mimetypes
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from chronicle_rift.game_engine import (  # noqa: E402
    resolve_purchase,
    resolve_turn,
    sell_item,
    upgrade_relic,
    use_item,
)
from chronicle_rift.models import new_player, public_player_view  # noqa: E402

WEBAPP = ROOT / "src" / "chronicle_rift" / "webapp"
PLAYER = new_player(user_id=1, first_name="Preview Hero", username="preview")

TELEGRAM_STUB = """
<script>
  window.Telegram = { WebApp: {
    initData: "preview",
    initDataUnsafe: {},
    ready() {}, expand() {},
    HapticFeedback: { impactOccurred() {}, notificationOccurred() {} },
  } };
</script>
"""


class PreviewHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: object) -> None:  # quieter console
        sys.stderr.write(f"{self.command} {self.path}\n")

    def _send(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, payload: dict[str, object], status: int = 200) -> None:
        self._send(status, json.dumps(payload).encode(), "application/json")

    def do_GET(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0]
        if path in {"/", "/app", "/app/"}:
            html = (WEBAPP / "index.html").read_text(encoding="utf-8")
            html = html.replace("<body>", "<body>" + TELEGRAM_STUB)
            self._send(200, html.encode(), "text/html; charset=utf-8")
            return
        if path == "/api/me":
            self._json({"player": public_player_view(PLAYER), "version": "preview"})
            return
        target = (WEBAPP / path.removeprefix("/app/").removeprefix("/")).resolve()
        if target.is_file() and str(target).startswith(str(WEBAPP)):
            kind = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
            self._send(200, target.read_bytes(), kind)
            return
        self._send(404, b"not found", "text/plain")

    def do_POST(self) -> None:  # noqa: N802
        global PLAYER
        length = int(self.headers.get("Content-Length", "0"))
        payload = json.loads(self.rfile.read(length) or b"{}")
        path = self.path.split("?", 1)[0]
        if path == "/api/actions":
            turn = resolve_turn(PLAYER, payload["action"])
            PLAYER = turn.player
            self._json(
                {
                    "player": public_player_view(PLAYER),
                    "turn": {
                        "action": turn.action,
                        "summary": turn.summary,
                        "narrative": turn.summary,
                        "victory": turn.victory,
                        "effects": turn.effects,
                    },
                }
            )
            return
        if path in {"/api/use", "/api/sell", "/api/upgrade"}:
            item_id = payload["item_id"]
            if path == "/api/use":
                result = use_item(PLAYER, item_id)
            elif path == "/api/sell":
                result = sell_item(PLAYER, item_id, int(payload.get("quantity", 1)))
            else:
                result = upgrade_relic(PLAYER, item_id)
            if result.success:
                PLAYER = result.player
            self._json(
                {
                    "player": public_player_view(PLAYER),
                    "turn": {
                        "item_id": result.item_id,
                        "item_name": result.item_name,
                        "summary": result.summary,
                        "success": result.success,
                        "reason": result.reason,
                        "effects": result.effects,
                    },
                }
            )
            return
        if path == "/api/buy":
            result = resolve_purchase(PLAYER, payload["item_id"])
            if result.success:
                PLAYER = result.player
            self._json(
                {
                    "player": public_player_view(PLAYER),
                    "turn": {
                        "item_id": result.item_id,
                        "item_name": result.item_name,
                        "summary": result.summary,
                        "success": result.success,
                        "reason": result.reason,
                    },
                }
            )
            return
        self._send(404, b"not found", "text/plain")


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    print(f"ChronicleRift Mini App preview on http://0.0.0.0:{port}")
    ThreadingHTTPServer(("0.0.0.0", port), PreviewHandler).serve_forever()
