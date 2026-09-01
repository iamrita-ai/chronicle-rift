from __future__ import annotations

import pytest

from chronicle_rift.config import Settings
from chronicle_rift.models import new_player
from chronicle_rift.rich_messages import (
    RichMessageClient,
    about_message,
    dashboard_messages,
    shop_messages,
)


class FakeBot:
    def __init__(self) -> None:
        self.sent: list[dict] = []

    async def send_message(self, **kwargs):
        self.sent.append(kwargs)


def test_dashboard_has_rich_table_and_plain_fallback() -> None:
    rich, plain = dashboard_messages(new_player(user_id=1, first_name="Rita", username=None))

    assert "| Hero | Value |" in rich
    assert "<details>" in rich
    assert "Ash Warden" in plain
    assert "Inventory:" in plain
    assert "Coins" in plain
    assert "Points" in plain
    assert "XP" in plain


def test_shop_and_about_messages_render() -> None:
    player = new_player(user_id=1, first_name="Rita", username=None)
    rich, plain = shop_messages(player)
    assert "The Marketplace" in plain
    assert "Coins" in plain

    rich, plain = about_message(version="0.2.0")
    assert "0.2.0" in plain
    assert "ChronicleRift" in plain


@pytest.mark.asyncio
async def test_falls_back_to_ordinary_message_when_rich_is_disabled() -> None:
    settings = Settings(
        bot_token="123:test",
        mongodb_uri="mongodb://localhost:27017",
        groq_api_key="test",
        rich_messages_enabled=False,
    )
    client = RichMessageClient(settings)
    bot = FakeBot()
    try:
        await client.send_or_fallback(
            bot=bot,
            chat_id=99,
            rich_markdown="# Rich",
            fallback_text="Plain fallback",
        )
    finally:
        await client.close()

    assert bot.sent == [{"chat_id": 99, "text": "Plain fallback", "reply_markup": None}]
