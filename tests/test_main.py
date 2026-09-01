from __future__ import annotations

import hashlib
import hmac
import json
from urllib.parse import urlencode

import httpx
import pytest

from chronicle_rift.config import Settings
from chronicle_rift.game_service import GameTurn
from chronicle_rift.main import create_app
from chronicle_rift.models import new_player, public_player_view


@pytest.mark.asyncio
async def test_health_and_unauthenticated_api_are_safe() -> None:
    settings = Settings(
        bot_token="123:test",
        mongodb_uri="mongodb://localhost:27017",
        groq_api_key="test",
        bot_mode="polling",
    )
    app = create_app(settings)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="https://testserver") as client:
        health = await client.get("/healthz")
        mini_app = await client.get("/app/")
        api = await client.get("/api/me")
        webhook = await client.post("/telegram/webhook", content=b"{}")

    assert health.status_code == 200
    assert health.json()["status"] == "ok"
    assert health.headers["x-content-type-options"] == "nosniff"
    assert mini_app.status_code == 200
    assert "ChronicleRift" in mini_app.text
    assert api.status_code == 401
    assert webhook.status_code == 404


def _signed_header(bot_token: str) -> str:
    fields = {
        "auth_date": "1800000000",
        "user": json.dumps({"id": 77, "first_name": "Verified"}, separators=(",", ":")),
    }
    data_check_string = "\n".join(f"{key}={fields[key]}" for key in sorted(fields))
    secret = hmac.new(b"WebAppData", bot_token.encode(), hashlib.sha256).digest()
    fields["hash"] = hmac.new(secret, data_check_string.encode(), hashlib.sha256).hexdigest()
    return urlencode(fields)


class StubGameService:
    def __init__(self) -> None:
        self.player = new_player(user_id=77, first_name="Verified", username=None)

    async def player_view(self, identity):
        assert identity.user_id == 77
        return public_player_view(self.player)

    async def take_turn(self, identity, action):
        assert identity.user_id == 77
        return GameTurn(
            player=self.player,
            action=action,
            summary="Stub turn.",
            narrative="A verified turn is written.",
            victory=False,
        )


@pytest.mark.asyncio
async def test_signed_mini_app_header_reaches_only_server_owned_game_service(monkeypatch) -> None:
    bot_token = "123:test"
    settings = Settings(
        bot_token=bot_token,
        mongodb_uri="mongodb://localhost:27017",
        groq_api_key="test",
        bot_mode="polling",
    )
    app = create_app(settings)
    # ASGITransport does not run lifespan; a stub isolates the authenticated route contract.
    app.state.game_service = StubGameService()
    monkeypatch.setattr("chronicle_rift.security.time.time", lambda: 1_800_000_000)
    transport = httpx.ASGITransport(app=app)
    headers = {"X-Telegram-Init-Data": _signed_header(bot_token)}
    async with httpx.AsyncClient(transport=transport, base_url="https://testserver") as client:
        profile = await client.get("/api/me", headers=headers)
        action = await client.post("/api/actions", headers=headers, json={"action": "scout"})
        forged = await client.post(
            "/api/actions",
            headers=headers,
            json={"action": "scout", "user_id": 999999},
        )

    assert profile.status_code == 200
    assert profile.json()["player"]["hero"]["name"] == "Verified"
    assert action.status_code == 200
    assert action.json()["turn"]["narrative"] == "A verified turn is written."
    assert forged.status_code == 422


@pytest.mark.asyncio
async def test_webhook_requires_secret_and_queues_a_valid_update() -> None:
    import asyncio
    from types import SimpleNamespace

    from telegram import Bot

    settings = Settings(
        bot_token="123:test",
        mongodb_uri="mongodb://localhost:27017",
        groq_api_key="test",
        bot_mode="webhook",
        public_base_url="https://chronicle.example",
        webhook_secret="expected-secret",
    )
    app = create_app(settings)
    queued_updates: asyncio.Queue = asyncio.Queue()
    app.state.telegram_application = SimpleNamespace(
        bot=Bot(settings.bot_token), update_queue=queued_updates
    )
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="https://testserver") as client:
        forbidden = await client.post("/telegram/webhook", json={"update_id": 123})
        accepted = await client.post(
            "/telegram/webhook",
            headers={"X-Telegram-Bot-Api-Secret-Token": "expected-secret"},
            json={"update_id": 123},
        )

    assert forbidden.status_code == 403
    assert accepted.status_code == 200
    assert (await queued_updates.get()).update_id == 123
