"""python-telegram-bot handlers for ChronicleRift's conversational surface."""

from __future__ import annotations

import logging
from typing import Any

from telegram import InlineKeyboardButton, InlineKeyboardMarkup, Update, WebAppInfo
from telegram.constants import KeyboardButtonStyle
from telegram.ext import Application, CallbackQueryHandler, CommandHandler, ContextTypes

from . import __version__
from .config import Settings
from .database import DatabaseUnavailable
from .game_engine import HOW_TO_PLAY, RULES, SHOP_ITEMS, VALID_ACTIONS
from .game_service import GameBusyError, GameService, PurchaseError
from .identity import TelegramIdentity
from .rich_messages import (
    RichMessageClient,
    RichMessageError,
    about_message,
    dashboard_messages,
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
            HOW_TO_PLAY,
            reply_markup=_home_keyboard(
                mini_app_url=settings.mini_app_url, include_mini_app=chat.type == "private"
            ),
        )

    async def rules_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        del context
        chat = update.effective_chat
        if not chat:
            return
        await chat.send_message(
            RULES,
            reply_markup=_home_keyboard(
                mini_app_url=settings.mini_app_url, include_mini_app=chat.type == "private"
            ),
        )

    async def about_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        del context
        chat = update.effective_chat
        if not chat:
            return
        _, plain = about_message(version=__version__)
        await chat.send_message(
            plain,
            reply_markup=_home_keyboard(
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
    application.add_handler(
        CallbackQueryHandler(choose_action, pattern=r"^act:(strike|guard|scout|rest)$")
    )
    application.add_handler(
        CallbackQueryHandler(callback_menu, pattern=r"^(rules|about|dashboard|shop:.*)$")
    )
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
    chat = update.effective_chat
    user = update.effective_user
    if not chat or not user:
        return
    if not _is_allowed(settings, user.id):
        await chat.send_message("This realm is not available to your account.")
        return
    try:
        player = await game_service.dashboard(_identity_from_update(user))
        rich, plain = dashboard_messages(player)
        if welcome:
            intro = (
                "# Welcome to ChronicleRift\n\n"
                "A turn-based RPG right here in Telegram. Defeat the enemy below, "
                "chapter by chapter. Each turn, pick ONE move — the four buttons "
                "under your dashboard. New here? /help explains every move in a "
                "minute.\n\n"
            )
            plain_intro = (
                "Welcome to ChronicleRift — a turn-based RPG in Telegram.\n"
                "Pick ONE move per turn (the buttons below) and drop the enemy's "
                "HP to 0 to clear each chapter. /help explains every move.\n\n"
            )
            rich = intro + rich
            plain = plain_intro + plain
        await rich_messages.send_or_fallback(
            bot=update.get_bot(),
            chat_id=chat.id,
            rich_markdown=rich,
            fallback_text=plain,
            reply_markup=action_keyboard(
                mini_app_url=settings.mini_app_url,
                include_mini_app=chat.type == "private",
            ),
        )
    except (DatabaseUnavailable, RichMessageError):
        LOGGER.exception("Unable to send Telegram dashboard")
        await chat.send_message("The Chronicle archives are briefly unavailable. Please try again.")


async def _send_dashboard_to(
    bot: Any,
    chat_id: int,
    game_service: GameService,
    rich_messages: RichMessageClient,
    settings: Settings,
    identity: TelegramIdentity,
) -> None:
    try:
        player = await game_service.dashboard(identity)
        rich, plain = dashboard_messages(player)
        await rich_messages.send_or_fallback(
            bot=bot,
            chat_id=chat_id,
            rich_markdown=rich,
            fallback_text=plain,
            reply_markup=action_keyboard(
                mini_app_url=settings.mini_app_url,
                include_mini_app=True,
            ),
        )
    except (DatabaseUnavailable, RichMessageError):
        LOGGER.exception("Unable to send Telegram dashboard")
        await bot.send_message(
            chat_id, "The Chronicle archives are briefly unavailable. Please try again."
        )


async def _send_shop_to(
    bot: Any,
    chat_id: int,
    game_service: GameService,
    rich_messages: RichMessageClient,
    settings: Settings,
    identity: TelegramIdentity,
) -> None:
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
    rows: list[list[InlineKeyboardButton]] = [
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
            _styled_button("📜 Rules", "rules", _STYLE_PRIMARY),
            _styled_button("ℹ️ About", "about", _STYLE_PRIMARY),
        ],
    ]
    if mini_app_url and include_mini_app:
        rows.append(
            [InlineKeyboardButton("✨ Tactical Mini App", web_app=WebAppInfo(mini_app_url))]
        )
    return InlineKeyboardMarkup(rows)


def shop_keyboard(*, player: dict[str, Any], private_chat: bool) -> InlineKeyboardMarkup:
    """Build a colored Marketplace keyboard from the authenticated player's balance."""
    coins = player["game"]["coins"]
    rows: list[list[InlineKeyboardButton]] = []
    for item_id, item in SHOP_ITEMS.items():
        affordable = coins >= item["cost"]
        style = _STYLE_SUCCESS if affordable else None
        rows.append(
            [
                _styled_button(
                    f"{item['emoji']} {item['name']} · {item['cost']}🪙",
                    f"shop:{item_id}",
                    style,
                )
            ]
        )
    rows.append([_styled_button("↩ Back to Chronicle", "dashboard", _STYLE_PRIMARY)])
    if private_chat:
        pass  # Mini App button is attached by the caller where relevant
    return InlineKeyboardMarkup(rows)


def _home_keyboard(*, mini_app_url: str | None, include_mini_app: bool) -> InlineKeyboardMarkup:
    """A minimal navigation keyboard for the rules / about surfaces."""
    rows: list[list[InlineKeyboardButton]] = [
        [_styled_button("🏟 Dashboard", "dashboard", _STYLE_PRIMARY)],
        [
            _styled_button("🏪 Marketplace", "shop:open", _STYLE_SUCCESS),
            _styled_button("📜 Rules", "rules", _STYLE_PRIMARY),
        ],
    ]
    if mini_app_url and include_mini_app:
        rows.append(
            [InlineKeyboardButton("✨ Tactical Mini App", web_app=WebAppInfo(mini_app_url))]
        )
    return InlineKeyboardMarkup(rows)


def _identity_from_update(user: Any) -> TelegramIdentity:
    return TelegramIdentity(user_id=user.id, first_name=user.first_name, username=user.username)


def _is_allowed(settings: Settings, user_id: int) -> bool:
    return not settings.allowed_user_ids or user_id in settings.allowed_user_ids
