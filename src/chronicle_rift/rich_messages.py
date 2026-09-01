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
    battle = view.get("battle", {})
    intent = enemy.get("intent") or {}
    inventory = ", ".join(_safe_text(item) for item in view["inventory"])
    narrative = _safe_text(view["narrative"])
    progress_text = _progress_bar(hero["progress"])
    inventory_bullets = inventory.replace(", ", "\n- ")
    focus_text = _focus_pips(hero.get("focus", 0), hero.get("max_focus", 3))
    intent_line = _intent_line(intent)
    coach = _coach_tip(hero, enemy, battle, intent)
    status_bits = []
    if battle.get("exposed"):
        status_bits.append("🎯 EXPOSED (next Strike +2)")
    if battle.get("burn"):
        status_bits.append(f"🔥 BURNING ({battle['burn']} turns)")
    if battle.get("can_finish"):
        status_bits.append("💀 FINISHER READY")
    status_line = " · ".join(status_bits)

    rich = (
        f"# ⚔️ {_safe_text(hero['name'])}'s Chronicle\n\n"
        f"> **Chapter {quest['chapter']} · {_safe_text(quest['title'])}**\n\n"
        f"## 📈 Progression · Level {hero['level']}\n"
        f"{progress_text} `{hero['xp']} / {hero['xp_to_next']} XP`\n\n"
        "| Hero | Value |\n| --- | ---: |\n"
        f"| HP | {hero['hp']} / {hero['max_hp']} |\n"
        f"| Energy | {hero['energy']} / {hero['max_energy']} |\n"
        f"| XP | {hero['xp']} |\n"
        f"| Gold | {hero['gold']} |\n"
        f"| 🪙 Coins | {hero['coins']} |\n"
        f"| ✨ Points | {hero['points']} |\n\n"
        f"| 🎯 Focus | {focus_text} |\n\n"
        f"## {enemy['art']} Enemy: {_safe_text(enemy['name'])}\n"
        f"**HP:** {enemy['hp']} / {enemy['max_hp']} · **ATK:** {enemy.get('attack', '?')}\n\n"
        f"> ⏭ **{_safe_text(intent_line)}**\n\n"
        + (f"`{_safe_text(status_line)}`\n\n" if status_line else "")
        + f"## Quest\n{_safe_text(quest['objective'])}\n\n"
        f"**Your move:** {_safe_text(coach)}\n\n"
        f"<details><summary>🎒 Inventory</summary>\n\n- {inventory_bullets}\n\n</details>\n\n"
        f"> {narrative}"
    )
    plain = (
        f"⚔️ {hero['name']}'s Chronicle\n"
        f"Chapter {quest['chapter']}: {quest['title']}\n\n"
        f"Level {hero['level']} — {progress_text} {hero['xp']}/{hero['xp_to_next']} XP\n\n"
        f"HP {hero['hp']}/{hero['max_hp']} | Energy {hero['energy']}/{hero['max_energy']}\n"
        f"Gold {hero['gold']} | Coins {hero['coins']} | Points {hero['points']}\n\n"
        f"Focus {focus_text}\n\n"
        f"{enemy['art']} {enemy['name']}: {enemy['hp']}/{enemy['max_hp']} HP "
        f"(ATK {enemy.get('attack', '?')})\n"
        f"⏭ {intent_line}\n"
        + (f"{status_line}\n" if status_line else "")
        + f"Quest: {quest['objective']}\n"
        f"Inventory: {inventory}\n\n{narrative}\n\n"
        f"👉 Your move: {coach}\n"
        f"New here? Send /help for the 60-second guide."
    )
    return rich, plain


def shop_messages(player: dict[str, Any]) -> tuple[str, str]:
    """Build the Marketplace rich markdown and plain-text fallback."""
    view = public_player_view(player)
    hero = view["hero"]
    lines = []
    for item in view["shop"]:
        lines.append(
            f"{item['emoji']} **{_safe_text(item['name'])}** \\- {item['cost']} Coins\n"
            f"{_safe_text(item['desc'])}"
        )
    rich_shop = "\n\n".join(lines)
    rich = f"# 🏪 The Marketplace\n\n> **Your balance:** 🪙 {hero['coins']} Coins\n\n{rich_shop}"
    plain_lines = []
    for item in view["shop"]:
        plain_lines.append(
            f"{item['emoji']} {item['name']} - {item['cost']} Coins\n{_itemize(item['desc'])}"
        )
    plain = (
        f"🏪 The Marketplace\n"
        f"Balance: {hero['coins']} Coins\n\n"
        + "\n\n".join(plain_lines)
        + "\n\nTap an item to buy it."
    )
    return rich, plain


def turn_messages(player: dict[str, Any], narrative: str) -> tuple[str, str]:
    """Build a post-turn Rich Message using server-controlled game state."""
    rich, plain = dashboard_messages(player)
    safe_narrative = _safe_text(narrative)
    return f"{rich}\n\n## ✨ Chronicle Update\n{safe_narrative}", f"{plain}\n\n✨ {safe_narrative}"


def about_message(*, version: str) -> tuple[str, str]:
    """Return game version and feature information (rich, plain)."""
    rich = (
        f"# ℹ️ About ChronicleRift\n\n"
        f"> **Version** `{_safe_text(version)}`\n\n"
        "A turn-based tactical fantasy adventure for Telegram. Defeat enemies, earn "
        "Gold, Coins and Points, level up, and shop for upgrades. Rules are resolved "
        "server-side and every turn is saved to your Chronicle.\n\n"
        "Commands: `/play`, `/shop`, `/rules`, `/about`, `/app`."
    )
    plain = (
        f"ℹ️ ChronicleRift v{version}\n\n"
        "A turn-based tactical fantasy adventure for Telegram. Defeat enemies, earn "
        "Gold, Coins and Points, level up, and shop for upgrades.\n\n"
        "Commands: /play, /shop, /rules, /about, /app."
    )
    return rich, plain


def _focus_pips(focus: int, maximum: int) -> str:
    """Render the combo meter, e.g. ◆◆◇ (2/3)."""
    focus = max(0, min(int(maximum), int(focus)))
    return f"{'◆' * focus}{'◇' * (int(maximum) - focus)} ({focus}/{maximum})"


def _intent_line(intent: dict[str, Any]) -> str:
    """One human sentence describing what the enemy will do next turn."""
    if not intent:
        return "The enemy's next move is unreadable."
    if intent.get("kind") == "heal":
        return f"Next: {intent['name']} — it heals itself for {intent.get('heal', 0)}."
    return f"Next: {intent.get('name', 'Attack')} — {intent.get('damage', 0)} damage incoming."


def _coach_tip(
    hero: dict[str, Any], enemy: dict[str, Any], battle: dict[str, Any], intent: dict[str, Any]
) -> str:
    """A single, always-correct suggestion so nobody stares at four buttons."""
    incoming = int(intent.get("damage", 0) or 0)
    if hero["hp"] <= 0:
        return "Tap any button to wake at camp, fully healed."
    if battle.get("can_finish"):
        return "⚔️ Strike — this hit can finish the enemy right now."
    if intent.get("kind") == "heal":
        return "⚔️ Strike — it is about to heal itself, so hurt it first."
    if hero["hp"] <= incoming:
        return "🛡 Guard or 🔥 Rest — that next hit could drop you."
    if incoming >= 8:
        return f"🛡 Guard — a {incoming} damage hit is coming."
    if hero["energy"] <= 0:
        return "🔥 Rest or 🛡 Guard — you need Rift Energy before you can Strike."
    if hero["hp"] / max(1, hero["max_hp"]) <= 0.4:
        return "🔥 Rest — heal up before you trade blows again."
    if int(hero.get("focus", 0)) >= int(hero.get("max_focus", 3)):
        return "⚔️ Strike — your Focus meter is full, cash it in."
    if not battle.get("exposed"):
        return "🔮 Scout — expose the enemy (+2 next Strike) and build Focus."
    return "⚔️ Strike — the enemy is exposed."


def _progress_bar(fraction: float, width: int = 10) -> str:
    """Render a small monospaced progress bar (e.g. ████░░░░░░)."""
    blocks = max(0, min(width, int(round(fraction * width))))
    return "█" * blocks + "░" * (width - blocks)


def _itemize(value: str) -> str:
    return "  • " + value


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
