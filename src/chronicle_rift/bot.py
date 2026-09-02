"""python-telegram-bot handlers for ChronicleRift's conversational surface."""

from __future__ import annotations

import logging
from typing import Any

from telegram import InlineKeyboardButton, InlineKeyboardMarkup, Update, WebAppInfo
from telegram.constants import KeyboardButtonStyle
from telegram.ext import (
    Application,
    CallbackQueryHandler,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

from . import __version__
from .config import Settings
from .database import DatabaseUnavailable
from .game_engine import HOW_TO_PLAY, RULES, VALID_ACTIONS
from .game_service import GameBusyError, GameService, PurchaseError
from .identity import TelegramIdentity
from .models import ITEMS, MAX_RELIC_LEVEL, SHOP_ITEMS, inventory_view, relic_cost
from .rich_messages import (
    RichMessageClient,
    RichMessageError,
    about_message,
    shop_messages,
    turn_messages,
)

LOGGER = logging.getLogger(__name__)

# Colored button styles (PTB >= 22.7; Telegram clients on/after Feb 9 2026 render them).
_STYLE_PRIMARY = KeyboardButtonStyle.PRIMARY  # blue
_STYLE_SUCCESS = KeyboardButtonStyle.SUCCESS  # green
_STYLE_DANGER = KeyboardButtonStyle.DANGER  # red

_ACTION_LABELS = {
    "strike": "⚔️ Strike",
    "guard": "🛡 Guard",
    "scout": "🔮 Scout",
    "rest": "🔥 Rest",
}

_ACTION_STYLES = {
    "strike": _STYLE_DANGER,
    "guard": _STYLE_PRIMARY,
    "scout": _STYLE_PRIMARY,
    "rest": _STYLE_SUCCESS,
}

_FEEDBACK_KINDS = {
    "bug": "🐛 Bug report",
    "feature": "✨ Feature request",
    "improve": "💡 Improvement idea",
}

REPO_URL = "https://github.com/iamrita-ai/chronicle-rift"
OWNER_CREDITS = (
    "👑 Owner — @TechnicalSerena (https://t.me/TechnicalSerena)\n"
    "🛠 Co-owner — @XioquiXan (https://t.me/XioquiXan)"
)

DEPLOY_TUTORIAL = "\n".join([
    "🚀 Deploy ChronicleRift — your own realm in ~10 minutes",
    "",
    "▸ ANY VPS (DigitalOcean, Hetzner, AWS, Oracle free tier…)",
    "1. Ubuntu 22.04+, open port 443, point a domain at the box.",
    "2. git clone https://github.com/iamrita-ai/chronicle-rift",
    "3. Copy .env.example → .env and fill BOT_TOKEN (@BotFather),",
    "   MONGODB_URI (free Atlas cluster), GROQ_API_KEY (console.groq.com).",
    "4. Docker (easiest): docker build -t chronicle-rift .",
    "   docker run -d --env-file .env -p 8000:8000 chronicle-rift",
    "   then Caddy/Nginx + TLS in front, PUBLIC_BASE_URL=https://your.domain",
    "   or systemd: python -m venv .venv && .venv/bin/pip install -e .",
    "   with a unit running .venv/bin/python -m chronicle_rift (webhook mode).",
    "5. In @BotFather attach the Mini App URL (https://your.domain/app).",
    "",
    "▸ RENDER (zero-ops)",
    "Import the repo on render.com — render.yaml wires the web service.",
    "Add the three secrets; Render sets RENDER_EXTERNAL_URL for you.",
    "",
    "▸ LOCAL (just play / develop)",
    'pip install -e ".[dev]" then python tools/preview_miniapp.py and open',
    "http://localhost:8080 — the full Mini App, stubbed Telegram, no accounts.",
    "Real bot locally: fill .env, keep BOT_MODE=polling, python -m chronicle_rift.",
    "",
    "Full guide, badges and security notes live in README.md on the repo.",
])


def art_url(settings: Settings, name: str) -> str | None:
    """Public HTTPS URL of a bundled illustration, served by our own Mini App."""
    base = settings.mini_app_url
    if not base:
        return None
    return f"{base.rstrip('/')}/art/{name}.jpg"


async def _send_art(bot: Any, chat_id: int, settings: Settings, name: str, caption: str) -> None:
    """Best-effort illustrated message; the game never depends on it succeeding."""
    url = art_url(settings, name)
    if not url:
        return
    try:
        await bot.send_photo(chat_id=chat_id, photo=url, caption=caption)
    except Exception:
        LOGGER.debug("Could not send illustration %s", name)


def _styled_button(text: str, callback_data: str, style: str | None = None) -> InlineKeyboardButton:
    """Build an InlineKeyboardButton, optionally colored via the style field."""
    return InlineKeyboardButton(text, callback_data=callback_data, style=style)


def build_telegram_application(
    *, settings: Settings, game_service: GameService, rich_messages: RichMessageClient
) -> Application:
    """Build the PTB application that FastAPI feeds webhook updates into."""
    application = Application.builder().token(settings.bot_token).build()

    async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        del context
        await _show_dashboard(update, game_service, rich_messages, settings, welcome=True)

    async def status(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        del context
        await _show_dashboard(update, game_service, rich_messages, settings, welcome=False)

    async def help_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        del context
        chat = update.effective_chat
        if not chat:
            return
        await chat.send_message(
            "Everything is explained inside the app.",
            reply_markup=_launch_keyboard(
                mini_app_url=settings.mini_app_url, include_mini_app=chat.type == "private"
            ),
        )

    async def rules_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        del context
        chat = update.effective_chat
        if not chat:
            return
        await chat.send_message(
            "Rules & Regulations and Terms & Conditions live inside the app — "
            "tap the 📜 or the 📄 button below.",
            reply_markup=_launch_keyboard(
                mini_app_url=settings.mini_app_url, include_mini_app=chat.type == "private"
            ),
        )

    async def about_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        del context
        chat = update.effective_chat
        if not chat:
            return
        await chat.send_message(
            f"ChronicleRift v{__version__}",
            reply_markup=_launch_keyboard(
                mini_app_url=settings.mini_app_url, include_mini_app=chat.type == "private"
            ),
        )

    async def shop_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        del context
        user = update.effective_user
        chat = update.effective_chat
        if not user or not chat:
            return
        if not _is_allowed(settings, user.id):
            await chat.send_message("This realm is not available to your account.")
            return
        try:
            player = await game_service.dashboard(_identity_from_update(user))
            rich, plain = shop_messages(player)
            await rich_messages.send_or_fallback(
                bot=update.get_bot(),
                chat_id=chat.id,
                rich_markdown=rich,
                fallback_text=plain,
                reply_markup=shop_keyboard(player=player, private_chat=chat.type == "private"),
            )
        except (DatabaseUnavailable, RichMessageError):
            LOGGER.exception("Unable to send Telegram shop")
            await chat.send_message(
                "The Chronicle archives are briefly unavailable. Please try again."
            )

    async def bag_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        del context
        user = update.effective_user
        chat = update.effective_chat
        if not user or not chat:
            return
        if not _is_allowed(settings, user.id):
            await chat.send_message("This realm is not available to your account.")
            return
        try:
            player = await game_service.dashboard(_identity_from_update(user))
        except DatabaseUnavailable:
            LOGGER.exception("Unable to load the satchel")
            await chat.send_message("The Chronicle archives are briefly unavailable.")
            return
        await chat.send_message(
            bag_message(player),
            reply_markup=_home_keyboard(
                mini_app_url=settings.mini_app_url, include_mini_app=chat.type == "private"
            ),
        )

    async def app_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        del context
        chat = update.effective_chat
        user = update.effective_user
        if not chat or not user:
            return
        if not _is_allowed(settings, user.id):
            await chat.send_message("This realm is not available to your account.")
            return
        if chat.type != "private" or not settings.mini_app_url:
            await chat.send_message(
                "The Mini App needs an HTTPS deployment and can be opened from a private chat. "
                "Use /play for the bot dashboard."
            )
            return
        await chat.send_message(
            "Open the tactical board:",
            reply_markup=InlineKeyboardMarkup(
                [
                    [
                        InlineKeyboardButton(
                            "✨ Open ChronicleRift", web_app=WebAppInfo(settings.mini_app_url)
                        )
                    ]
                ]
            ),
        )

    async def choose_action(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        query = update.callback_query
        user = update.effective_user
        if not query or not user or not query.message:
            return
        action = (query.data or "").removeprefix("act:")
        if action not in VALID_ACTIONS:
            await query.answer("That rift action is no longer available.", show_alert=True)
            return
        if not _is_allowed(settings, user.id):
            await query.answer("This realm is not available to your account.", show_alert=True)
            return

        await query.answer("The rift shifts…")
        identity = _identity_from_update(user)
        try:
            turn = await game_service.take_turn(identity, action)
            rich, plain = turn_messages(turn.player, turn.narrative)
            keyboard = action_keyboard(
                mini_app_url=settings.mini_app_url,
                include_mini_app=query.message.chat.type == "private",
            )
            await rich_messages.send_or_fallback(
                bot=context.bot,
                chat_id=query.message.chat_id,
                rich_markdown=rich,
                fallback_text=plain,
                reply_markup=keyboard,
            )
        except GameBusyError:
            await query.message.reply_text("The rift moved in another window. Please choose again.")
        except (DatabaseUnavailable, RichMessageError):
            LOGGER.exception("Unable to complete Telegram game action")
            await query.message.reply_text(
                "The Chronicle archives are briefly unavailable. Please try again."
            )
        except Exception:
            LOGGER.exception("Unexpected Telegram game action failure")
            await query.message.reply_text("The rift flickers unexpectedly. Please try again.")

    async def callback_menu(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        query = update.callback_query
        user = update.effective_user
        if not query or not user or not query.message:
            return
        data = query.data or ""
        if not _is_allowed(settings, user.id):
            await query.answer("This realm is not available to your account.", show_alert=True)
            return
        identity = _identity_from_update(user)

        if data == "bag":
            await query.answer()
            try:
                player = await game_service.dashboard(identity)
            except DatabaseUnavailable:
                await query.answer("The archives are briefly unavailable.", show_alert=True)
                return
            await query.message.reply_text(
                bag_message(player),
                reply_markup=_home_keyboard(
                    mini_app_url=settings.mini_app_url,
                    include_mini_app=query.message.chat.type == "private",
                ),
            )
            return
        if data == "noop":
            await query.answer("Already at maximum level.")
            return
        if data == "howto":
            await query.answer()
            await query.message.reply_text(
                HOW_TO_PLAY,
                reply_markup=_home_keyboard(
                    mini_app_url=settings.mini_app_url,
                    include_mini_app=query.message.chat.type == "private",
                ),
            )
            return
        if data == "rules":
            await query.answer()
            await query.message.reply_text(
                RULES,
                reply_markup=_home_keyboard(
                    mini_app_url=settings.mini_app_url,
                    include_mini_app=query.message.chat.type == "private",
                ),
            )
            return
        if data == "about":
            await query.answer()
            _, plain = about_message(version=__version__)
            await query.message.reply_text(
                plain,
                reply_markup=_home_keyboard(
                    mini_app_url=settings.mini_app_url,
                    include_mini_app=query.message.chat.type == "private",
                ),
            )
            return
        if data == "tutorial":
            await query.answer()
            await query.message.reply_text(
                DEPLOY_TUTORIAL,
                reply_markup=_home_keyboard(
                    mini_app_url=settings.mini_app_url,
                    include_mini_app=query.message.chat.type == "private",
                ),
            )
            return
        if data == "owners":
            await query.answer()
            await query.message.reply_text(
                "👑 The keepers of the rift\n\n" + OWNER_CREDITS + "\n\n"
                "🧑‍ Source, issues & contributions: " + REPO_URL + "\n"
                "🔐 Security reports: see SECURITY.md in the repository.\n"
                "⚖️ License: MIT — play, fork and learn.",
                disable_web_page_preview=True,
            )
            return
        if data == "dashboard":
            await query.answer()
            await _send_dashboard_to(
                context.bot, query.message.chat_id, game_service, rich_messages, settings, identity
            )
            return
        if data == "shop:open":
            await query.answer()
            await _send_shop_to(
                context.bot,
                query.message.chat_id,
                game_service,
                rich_messages,
                settings,
                identity,
            )
            return
        if data.startswith("shop:"):
            item_id = data.removeprefix("shop:")
            if item_id == "noop":
                await query.answer("Already at maximum level.")
                return
            if item_id not in SHOP_ITEMS:
                await query.answer("That item is no longer available.", show_alert=True)
                return
            await query.answer()
            try:
                result = await game_service.buy_item(identity, item_id)
            except GameBusyError:
                await query.answer(
                    "Your chronicle changed in another window. Try again.", show_alert=True
                )
                return
            except (DatabaseUnavailable, PurchaseError):
                LOGGER.exception("Unable to complete Telegram shop purchase")
                await query.answer("The Marketplace is briefly unavailable.", show_alert=True)
                return
            except Exception:
                LOGGER.exception("Unexpected Telegram shop purchase failure")
                await query.answer(
                    "The rift flickers unexpectedly. Please try again.", show_alert=True
                )
                return
            if not result.success:
                await query.answer(result.summary, show_alert=True)
                return
            # Refresh the shop in place so the balance updates without spam.
            rich, plain = shop_messages(result.player)
            await rich_messages.send_or_fallback(
                bot=context.bot,
                chat_id=query.message.chat_id,
                rich_markdown=rich,
                fallback_text=plain,
                reply_markup=shop_keyboard(
                    player=result.player, private_chat=query.message.chat.type == "private"
                ),
            )
            await _notify_purchase(context.bot, query.message.chat_id, result.summary)
            return

    async def feedback_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        query = update.callback_query
        user = update.effective_user
        if not query or not user or not query.message:
            return
        kind = (query.data or "").removeprefix("feedback:")
        if kind not in _FEEDBACK_KINDS and kind != "any":
            await query.answer("That option is no longer available.", show_alert=True)
            return
        if not _is_allowed(settings, user.id):
            await query.answer("This realm is not available to your account.", show_alert=True)
            return
        context.user_data["feedback_kind"] = kind
        await query.answer()
        await query.message.reply_text(
            "📨 Send me your note as the next message — a few lines is perfect.\n"
            "One button, every kind: I file it as a 🐛 bug, ✨ feature or 💡 "
            "improvement automatically (or start your message with one of those "
            "emoji to choose).",
            reply_markup=_launch_keyboard(
                mini_app_url=settings.mini_app_url,
                include_mini_app=query.message.chat.type == "private",
            ),
        )

    async def feedback_text(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        user = update.effective_user
        message = update.effective_message
        if not user or not message or not message.text:
            return
        kind = context.user_data.pop("feedback_kind", None)
        if not kind:
            return
        if not _is_allowed(settings, user.id):
            return
        text = message.text.strip()[:2000]
        if kind == "any":
            kind = _detect_feedback_kind(text)
        if not text:
            await message.reply_text("Please send a short description as plain text.")
            context.user_data["feedback_kind"] = kind
            return
        try:
            await game_service.save_feedback(_identity_from_update(user), kind, text)
            # deliver the note straight to every owner's private chat
            forwarded = 0
            for owner_id in settings.owner_user_ids:
                if owner_id == user.id:
                    continue
                try:
                    await context.bot.send_message(
                        owner_id,
                        f"📨 {_FEEDBACK_KINDS[kind]} from {user.first_name} "
                        f"(tg:{user.id})\n\n{text}",
                    )
                    forwarded += 1
                except Exception:
                    LOGGER.debug("Could not forward feedback to owner %s", owner_id)
            if forwarded:
                await message.reply_text(
                    "💙 Thank you! Your note is recorded in the Chronicle and was "
                    "delivered straight to the owners."
                )
            else:
                await message.reply_text(
                    "💙 Thank you! Your note is recorded in the Chronicle. "
                    "I read every one of them before each new build."
                )
        except DatabaseUnavailable:
            LOGGER.exception("Unable to store Telegram feedback")
            await message.reply_text(
                "The Chronicle archives are briefly unavailable, so I could not save the note. "
                "Please send it again in a moment."
            )

    async def on_error(update: object, context: ContextTypes.DEFAULT_TYPE) -> None:
        del update
        LOGGER.error("Unhandled Telegram handler error: %s", type(context.error).__name__)

    application.add_handler(CommandHandler("start", start))
    application.add_handler(CommandHandler("play", status))
    application.add_handler(CommandHandler("status", status))
    application.add_handler(CommandHandler("help", help_command))
    application.add_handler(CommandHandler("rules", rules_command))
    application.add_handler(CommandHandler("about", about_command))
    application.add_handler(CommandHandler("shop", shop_command))
    application.add_handler(CommandHandler("app", app_command))
    application.add_handler(CommandHandler("bag", bag_command))
    application.add_handler(CommandHandler("inventory", bag_command))
    application.add_handler(
        CallbackQueryHandler(choose_action, pattern=r"^act:(strike|guard|scout|rest)$")
    )
    application.add_handler(
        CallbackQueryHandler(
            callback_menu,
            pattern=r"^(rules|about|howto|bag|noop|dashboard|tutorial|owners|shop:.*)$",
        )
    )
    application.add_handler(
        CallbackQueryHandler(feedback_start, pattern=r"^feedback:(bug|feature|improve|any)$")
    )
    application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, feedback_text))
    application.add_error_handler(on_error)
    return application


async def _show_dashboard(
    update: Update,
    game_service: GameService,
    rich_messages: RichMessageClient,
    settings: Settings,
    *,
    welcome: bool,
) -> None:
    """The bot home: a short greeting and the colored launcher menu.

    No status walls — every button opens the matching Mini App screen
    directly (arena, store, satchel, heroes, profile, rules, terms), and
    the red row collects feedback.
    """
    del game_service, rich_messages, welcome
    chat = update.effective_chat
    user = update.effective_user
    if not chat or not user:
        return
    if not _is_allowed(settings, user.id):
        await chat.send_message("This realm is not available to your account.")
        return
    keyboard = _launch_keyboard(
        mini_app_url=settings.mini_app_url,
        include_mini_app=chat.type == "private",
    )
    caption = (
        "⚔️ ChronicleRift v" + __version__ + " — the living chronicle awaits.\n\n"
        + OWNER_CREDITS + "\n\n"
        "Tap a coloured button — each one opens its own screen inside the arena app."
    )
    poster = art_url(settings, "hero") or art_url(settings, "realm")
    if poster:
        try:
            await chat.send_photo(photo=poster, caption=caption, reply_markup=keyboard)
            return
        except Exception:
            LOGGER.debug("Poster send failed; falling back to text", exc_info=True)
    await chat.send_message(caption, reply_markup=keyboard)


async def _send_dashboard_to(
    bot: Any,
    chat_id: int,
    game_service: GameService,
    rich_messages: RichMessageClient,
    settings: Settings,
    identity: TelegramIdentity,
) -> None:
    del game_service, rich_messages, identity
    await bot.send_message(
        chat_id,
        "⚔️ ChronicleRift v" + __version__,
        reply_markup=_launch_keyboard(mini_app_url=settings.mini_app_url, include_mini_app=True),
    )


def _web_button(
    label: str, start_param: str, style: str | None, mini_app_url: str
) -> InlineKeyboardButton:
    """Colored Mini App launcher button; the start parameter deep-links a screen."""
    return InlineKeyboardButton(
        label,
        web_app=WebAppInfo(mini_app_url, api_kwargs={"start_parameter": start_param}),
        style=style,
    )


def _launch_keyboard(*, mini_app_url: str | None, include_mini_app: bool) -> InlineKeyboardMarkup:
    """The home menu: colored buttons that deep-link straight into the Mini App.

    Telegram renders styled inline buttons (PRIMARY blue, SUCCESS green,
    DANGER red) on clients updated after Feb 2026; older clients still get
    ordinary blue buttons with the same behaviour.
    """
    rows: list[list[InlineKeyboardButton]] = []
    if mini_app_url and include_mini_app:
        rows.append(
            [_web_button("▶️  PLAY — RIFT ARENA", "play", _STYLE_SUCCESS, mini_app_url)]
        )
        rows.append(
            [
                _web_button("🏪  Store", "shop", _STYLE_PRIMARY, mini_app_url),
                _web_button("🎒  Satchel", "satchel", _STYLE_PRIMARY, mini_app_url),
            ]
        )
        rows.append(
            [
                _web_button("🧙  Heroes", "heroes", _STYLE_PRIMARY, mini_app_url),
                _web_button("👤  My Profile", "profile", _STYLE_SUCCESS, mini_app_url),
            ]
        )
        rows.append(
            [
                _web_button("📜  Rules & Regulations", "rules", _STYLE_PRIMARY, mini_app_url),
                _web_button("📄  Terms & Conditions", "terms", _STYLE_PRIMARY, mini_app_url),
            ]
        )
        rows.append(
            [
                # one button for every kind of note — the kind is auto-detected
                _styled_button(
                    "📨  Feedback — 🐛 bug · ✨ feature · 💡 improve",
                    "feedback:any",
                    _STYLE_DANGER,
                ),
            ]
        )
        rows.append(
            [
                _styled_button("🚀  Deploy Tutorial", "tutorial", _STYLE_PRIMARY),
                _styled_button("👑  Owners & Credits", "owners", _STYLE_PRIMARY),
            ]
        )
        rows.append(
            [
                InlineKeyboardButton("🧑‍💻  Source · Contribute", url=REPO_URL),
                InlineKeyboardButton("🔗  Share Mini App", url=_share_url(mini_app_url)),
            ]
        )
    return InlineKeyboardMarkup(rows)


def _detect_feedback_kind(text: str) -> str:
    """One feedback button serves all kinds; guess the kind from the note."""
    t = text.lower()
    if t.startswith("🐛") or any(
        w in t for w in ("bug", "crash", "error", "broken", "fix", "freeze", "stuck", "lag")
    ):
        return "bug"
    if t.startswith("✨") or any(w in t for w in ("feature", "add ", "new ", "please add")):
        return "feature"
    return "improve"


def _share_url(mini_app_url: str | None) -> str:
    """A t.me share link carrying the public Mini App URL."""
    from urllib.parse import quote

    target = mini_app_url or REPO_URL
    text = "ChronicleRift — a tactical elemental RPG that lives inside Telegram. Enter the rift!"
    return f"https://t.me/share/url?url={quote(target)}&text={quote(text)}"


async def _send_shop_to(
    bot: Any,
    chat_id: int,
    game_service: GameService,
    rich_messages: RichMessageClient,
    settings: Settings,
    identity: TelegramIdentity,
) -> None:
    del settings
    try:
        player = await game_service.dashboard(identity)
        rich, plain = shop_messages(player)
        await rich_messages.send_or_fallback(
            bot=bot,
            chat_id=chat_id,
            rich_markdown=rich,
            fallback_text=plain,
            reply_markup=shop_keyboard(player=player, private_chat=True),
        )
    except (DatabaseUnavailable, RichMessageError):
        LOGGER.exception("Unable to send Telegram shop")
        await bot.send_message(chat_id, "The Marketplace is briefly unavailable. Please try again.")


async def _notify_purchase(bot: Any, chat_id: int, summary: str) -> None:
    try:
        await bot.send_message(chat_id, f"🛍 {summary}")
    except Exception:
        LOGGER.debug("Could not send purchase confirmation message")


def action_keyboard(*, mini_app_url: str | None, include_mini_app: bool) -> InlineKeyboardMarkup:
    """Build a compact shared keyboard for rich and ordinary Telegram messages."""
    rows: list[list[InlineKeyboardButton]] = []
    if mini_app_url and include_mini_app:
        rows.append([InlineKeyboardButton("▶️ PLAY — RIFT ARENA", web_app=WebAppInfo(mini_app_url))])
    rows += [
        [
            _styled_button(_ACTION_LABELS["strike"], "act:strike", _ACTION_STYLES["strike"]),
            _styled_button(_ACTION_LABELS["guard"], "act:guard", _ACTION_STYLES["guard"]),
        ],
        [
            _styled_button(_ACTION_LABELS["scout"], "act:scout", _ACTION_STYLES["scout"]),
            _styled_button(_ACTION_LABELS["rest"], "act:rest", _ACTION_STYLES["rest"]),
        ],
        [
            _styled_button("🏪 Marketplace", "shop:open", _STYLE_PRIMARY),
            _styled_button("🎒 Satchel", "bag", _STYLE_PRIMARY),
        ],
        [
            _styled_button("📖 How to Play", "howto", _STYLE_PRIMARY),
            _styled_button("📜 Rules", "rules", _STYLE_PRIMARY),
            _styled_button("ℹ️ About", "about", _STYLE_PRIMARY),
        ],
    ]
    return InlineKeyboardMarkup(rows)


def shop_keyboard(*, player: dict[str, Any], private_chat: bool) -> InlineKeyboardMarkup:
    """Build a colored Marketplace keyboard from the authenticated player's balance."""
    game = player["game"]
    coins = game["coins"]
    relics = game.get("relics") or {}
    rows: list[list[InlineKeyboardButton]] = []
    for item_id, item in SHOP_ITEMS.items():
        if item["kind"] == "relic":
            level = int(relics.get(item_id, 0))
            if level >= MAX_RELIC_LEVEL:
                rows.append(
                    [_styled_button(f"{item['emoji']} {item['name']} · MAX", "shop:noop", None)]
                )
                continue
            price = relic_cost(item_id, level)
            label = f"{item['emoji']} {item['name']} Lv{level + 1} · {price}🪙"
        else:
            price = int(item["cost"])
            held = int((game.get("inventory") or {}).get(item_id, 0))
            suffix = f" (x{held})" if held else ""
            label = f"{item['emoji']} {item['name']}{suffix} · {price}🪙"
        style = _STYLE_SUCCESS if coins >= price else None
        rows.append([_styled_button(label, f"shop:{item_id}", style)])
    rows.append(
        [
            _styled_button("🎒 Satchel", "bag", _STYLE_PRIMARY),
            _styled_button("↩ Chronicle", "dashboard", _STYLE_PRIMARY),
        ]
    )
    if private_chat:
        pass  # Mini App button is attached by the caller where relevant
    return InlineKeyboardMarkup(rows)


def bag_message(player: dict[str, Any]) -> str:
    """Plain-text satchel summary for the bot surface."""
    game = player["game"]
    lines = ["🎒 Your Satchel", ""]
    cards = inventory_view(game)
    if not cards:
        lines.append("Empty. Clear a chapter — every victory drops random loot.")
    else:
        for card in cards:
            lines.append(
                f"{card['emoji']} {card['name']} x{card['quantity']} — {card['ability']} "
                f"(sells for {card['sell']}🪙 each)"
            )
    relics = game.get("relics") or {}
    lines.append("")
    lines.append("⚒ Relics")
    if not relics:
        lines.append("None yet — buy one in /shop, then upgrade it up to level 5.")
    else:
        for item_id, level in relics.items():
            item = ITEMS[item_id]
            lines.append(f"{item['emoji']} {item['name']} — level {level}/{MAX_RELIC_LEVEL}")
    lines.append("")
    lines.append(
        "Using, selling and upgrading items happens in the Rift Arena Mini App — tap ▶️ PLAY below."
    )
    return "\n".join(lines)


def _home_keyboard(*, mini_app_url: str | None, include_mini_app: bool) -> InlineKeyboardMarkup:
    """Kept for older surfaces — it is now the same bare launcher."""
    return _launch_keyboard(mini_app_url=mini_app_url, include_mini_app=include_mini_app)


def _identity_from_update(user: Any) -> TelegramIdentity:
    return TelegramIdentity(user_id=user.id, first_name=user.first_name, username=user.username)


def _is_allowed(settings: Settings, user_id: int) -> bool:
    if user_id in settings.owner_user_ids:
        return True
    return not settings.allowed_user_ids or user_id in settings.allowed_user_ids
