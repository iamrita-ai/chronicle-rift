"""Raw Bot API adapter for Telegram Rich Messages with a PTB-safe fallback."""

from __future__ import annotations

import logging
from collections.abc import Mapping
from typing import Any

import httpx
from telegram import Bot, InlineKeyboardMarkup
from telegram.error import TelegramError

from .config import Settings
from .models import public_player_view

LOGGER = logging.getLogger(__name__)


class RichMessageError(RuntimeError):
    """Raised when Telegram declines a native Rich Message request."""


class RichMessageClient:
    """Calls sendRichMessage while PTB catches up with Bot API 10.1+ types."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._http = httpx.AsyncClient(timeout=httpx.Timeout(20.0, connect=10.0))

    async def close(self) -> None:
        await self._http.aclose()

    async def send_markdown(
        self,
        *,
        chat_id: int,
        markdown: str,
        reply_markup: InlineKeyboardMarkup | None = None,
    ) -> Mapping[str, Any]:
        """Send a Bot API 10.1 Rich Message described by safe markdown."""
        payload: dict[str, Any] = {
            "chat_id": chat_id,
            "rich_message": {"markdown": markdown},
        }
        if reply_markup:
            payload["reply_markup"] = reply_markup.to_dict()

        try:
            response = await self._http.post(
                f"{self._settings.rich_api_base_url}/bot{self._settings.bot_token}/sendRichMessage",
                json=payload,
            )
            data = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise RichMessageError("Telegram Rich Message request failed.") from exc

        if response.status_code >= 400 or not data.get("ok"):
            raise RichMessageError("Telegram Rich Message request was rejected.")
        result = data.get("result")
        if not isinstance(result, Mapping):
            raise RichMessageError("Telegram did not return a Rich Message result.")
        return result

    async def send_or_fallback(
        self,
        *,
        bot: Bot,
        chat_id: int,
        rich_markdown: str,
        fallback_text: str,
        reply_markup: InlineKeyboardMarkup | None = None,
    ) -> None:
        """Use native rich UI when enabled; always keep a legacy-message path."""
        if self._settings.rich_messages_enabled:
            try:
                await self.send_markdown(
                    chat_id=chat_id, markdown=rich_markdown, reply_markup=reply_markup
                )
                return
            except RichMessageError:
                LOGGER.info("Rich Message unavailable; using standard Telegram message fallback")
        try:
            await bot.send_message(chat_id=chat_id, text=fallback_text, reply_markup=reply_markup)
        except TelegramError as exc:
            raise RichMessageError("Fallback Telegram message could not be sent.") from exc


def dashboard_messages(player: dict[str, Any]) -> tuple[str, str]:
    """Build rich markdown and universal plain-text fallback for a player dashboard."""
    view = public_player_view(player)
    hero = view["hero"]
    quest = view["quest"]
    enemy = view["enemy"]
    inventory = ", ".join(_safe_text(item) for item in view["inventory"])
    narrative = _safe_text(view["narrative"])

    inventory_bullets = inventory.replace(", ", "\n- ")

    rich = (
        f"# ⚔️ {_safe_text(hero['name'])}'s Chronicle\n\n"
        f"> **Chapter {quest['chapter']} · {_safe_text(quest['title'])}**\n\n"
        "| Hero | Value |\n| --- | ---: |\n"
        f"| Level | {hero['level']} |\n| HP | {hero['hp']} / {hero['max_hp']} |\n"
        f"| Energy | {hero['energy']} / {hero['max_energy']} |\n"
        f"| XP | {hero['xp']} |\n| Gold | {hero['gold']} |\n\n"
        f"## {enemy['art']} Enemy: {_safe_text(enemy['name'])}\n"
        f"**HP:** {enemy['hp']} / {enemy['max_hp']}\n\n"
        f"## Quest\n{_safe_text(quest['objective'])}\n\n"
        f"<details><summary>🎒 Inventory</summary>\n\n- {inventory_bullets}\n\n</details>\n\n"
        f"> {narrative}"
    )
    plain = (
        f"⚔️ {hero['name']}'s Chronicle\n"
        f"Chapter {quest['chapter']}: {quest['title']}\n\n"
        f"Level {hero['level']} | HP {hero['hp']}/{hero['max_hp']} | "
        f"Energy {hero['energy']}/{hero['max_energy']}\n"
        f"XP {hero['xp']} | Gold {hero['gold']}\n\n"
        f"{enemy['art']} {enemy['name']}: {enemy['hp']}/{enemy['max_hp']} HP\n"
        f"Quest: {quest['objective']}\n"
        f"Inventory: {inventory}\n\n{narrative}"
    )
    return rich, plain


def turn_messages(player: dict[str, Any], narrative: str) -> tuple[str, str]:
    """Build a post-turn Rich Message using server-controlled game state."""
    rich, plain = dashboard_messages(player)
    safe_narrative = _safe_text(narrative)
    return f"{rich}\n\n## ✨ Chronicle Update\n{safe_narrative}", f"{plain}\n\n✨ {safe_narrative}"


def _safe_text(value: object) -> str:
    """Keep generated/user text from breaking a rich markdown structure."""
    return " ".join(
        str(value)
        .replace("\\", "")
        .replace("|", "¦")
        .replace("<", "‹")
        .replace(">", "›")
        .replace("*", "")
        .replace("_", "")
        .replace("`", "")
        .replace("[", "(")
        .replace("]", ")")
        .replace("#", "")
        .split()
    )[:700]
