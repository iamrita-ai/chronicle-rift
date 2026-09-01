"""python-telegram-bot handlers for ChronicleRift's conversational surface."""

from __future__ import annotations

import logging
from typing import Any

from telegram import InlineKeyboardButton, InlineKeyboardMarkup, Update, WebAppInfo
from telegram.ext import Application, CallbackQueryHandler, CommandHandler, ContextTypes

from .config import Settings
from .database import DatabaseUnavailable
from .game_engine import VALID_ACTIONS
from .game_service import GameBusyError, GameService
from .identity import TelegramIdentity
from .rich_messages import RichMessageClient, RichMessageError, dashboard_messages, turn_messages

LOGGER = logging.getLogger(__name__)
_ACTION_LABELS = {
    "strike": "⚔️ Strike",
    "guard": "🛡 Guard",
    "scout": "🔮 Scout",
    "rest": "🔥 Rest",
}


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
        if not update.effective_chat:
            return
        await update.effective_chat.send_message(
            "ChronicleRift is a turn-based fantasy adventure.\n\n"
            "Use /play for your dashboard, choose Strike, Guard, Scout, or Rest, "
            "or open the Mini App for a tactical view. Every game action is saved."
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

    async def on_error(update: object, context: ContextTypes.DEFAULT_TYPE) -> None:
        del update
        LOGGER.error("Unhandled Telegram handler error: %s", type(context.error).__name__)

    application.add_handler(CommandHandler("start", start))
    application.add_handler(CommandHandler("play", status))
    application.add_handler(CommandHandler("status", status))
    application.add_handler(CommandHandler("help", help_command))
    application.add_handler(CommandHandler("app", app_command))
    application.add_handler(
        CallbackQueryHandler(choose_action, pattern=r"^act:(strike|guard|scout|rest)$")
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
            rich = "# Welcome to ChronicleRift\n\n" + rich
            plain = "Welcome to ChronicleRift\n\n" + plain
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


def action_keyboard(*, mini_app_url: str | None, include_mini_app: bool) -> InlineKeyboardMarkup:
    """Build a compact shared keyboard for rich and ordinary Telegram messages."""
    rows: list[list[InlineKeyboardButton]] = [
        [
            InlineKeyboardButton(_ACTION_LABELS["strike"], callback_data="act:strike"),
            InlineKeyboardButton(_ACTION_LABELS["guard"], callback_data="act:guard"),
        ],
        [
            InlineKeyboardButton(_ACTION_LABELS["scout"], callback_data="act:scout"),
            InlineKeyboardButton(_ACTION_LABELS["rest"], callback_data="act:rest"),
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
