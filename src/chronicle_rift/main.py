"""FastAPI webhook host and authenticated Telegram Mini App API."""

from __future__ import annotations

import json
import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Literal

from fastapi import Depends, FastAPI, HTTPException, Request, status
from fastapi.responses import JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict
from telegram import Update

from . import __version__
from .bot import build_telegram_application
from .config import Settings
from .database import DatabaseUnavailable, PlayerRepository
from .game_service import GameBusyError, GameService, PurchaseError
from .identity import TelegramIdentity
from .models import public_player_view
from .narrator import GroqNarrator
from .rich_messages import RichMessageClient
from .security import (
    MiniAppAuthenticationError,
    validate_mini_app_init_data,
    webhook_secret_is_valid,
)

LOGGER = logging.getLogger(__name__)
_MAX_WEBHOOK_BYTES = 1_000_000


class ActionRequest(BaseModel):
    """Mini App payload deliberately excludes user IDs and all game-state fields."""

    model_config = ConfigDict(extra="forbid")

    action: Literal["strike", "guard", "scout", "rest"]


class BuyRequest(BaseModel):
    """Mini App Marketplace purchase payload."""

    model_config = ConfigDict(extra="forbid")

    item_id: str


def create_app(settings: Settings | None = None) -> FastAPI:
    """Create the deployable service; settings can be injected for integration tests."""
    runtime_settings = settings or Settings.from_env()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        repository = PlayerRepository(
            runtime_settings.mongodb_uri, runtime_settings.mongodb_database
        )
        narrator = GroqNarrator(runtime_settings)
        rich_messages = RichMessageClient(runtime_settings)
        telegram_application = None
        telegram_initialized = False
        telegram_started = False
        polling_started = False
        try:
            await repository.connect()
            game_service = GameService(repository, narrator)
            telegram_application = build_telegram_application(
                settings=runtime_settings,
                game_service=game_service,
                rich_messages=rich_messages,
            )
            await telegram_application.initialize()
            telegram_initialized = True
            await telegram_application.start()
            telegram_started = True

            if runtime_settings.bot_mode == "webhook":
                await telegram_application.bot.set_webhook(
                    url=runtime_settings.webhook_url,
                    secret_token=runtime_settings.webhook_secret,
                    allowed_updates=Update.ALL_TYPES,
                )
                LOGGER.info("Telegram webhook registered at configured secure path")
            elif telegram_application.updater:
                await telegram_application.updater.start_polling(allowed_updates=Update.ALL_TYPES)
                polling_started = True
                LOGGER.info("Telegram polling started for local development")

            app.state.game_service = game_service
            app.state.telegram_application = telegram_application
            app.state.settings = runtime_settings
            yield
        finally:
            if telegram_application is not None:
                if polling_started and telegram_application.updater:
                    await telegram_application.updater.stop()
                if telegram_started:
                    await telegram_application.stop()
                if telegram_initialized:
                    await telegram_application.shutdown()
            await rich_messages.close()
            await narrator.close()
            await repository.close()

    app = FastAPI(
        title="ChronicleRift",
        version="0.1.0",
        description="Secure Telegram bot, Rich Message, and Mini App game service.",
        lifespan=lifespan,
        docs_url="/docs",
        redoc_url=None,
    )

    @app.middleware("http")
    async def security_headers(request: Request, call_next: Any) -> Any:
        response = await call_next(request)
        response.headers.setdefault("Referrer-Policy", "same-origin")
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault(
            "Permissions-Policy", "camera=(), microphone=(), geolocation=()"
        )
        response.headers.setdefault(
            "Content-Security-Policy",
            "default-src 'self'; "
            "script-src 'self' https://telegram.org; "
            "style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data:; "
            "connect-src 'self'; "
            "base-uri 'self'; form-action 'self'",
        )
        if request.url.path.startswith("/api/"):
            response.headers.setdefault("Cache-Control", "no-store")
        return response

    async def authenticated_identity(request: Request) -> TelegramIdentity:
        init_data = request.headers.get("x-telegram-init-data")
        if not init_data:
            authorization = request.headers.get("authorization", "")
            if authorization.lower().startswith("tma "):
                init_data = authorization[4:]
        if not init_data:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Telegram Mini App authentication is required.",
            )
        try:
            verified = validate_mini_app_init_data(
                init_data,
                bot_token=runtime_settings.bot_token,
                max_age_seconds=runtime_settings.mini_app_auth_max_age_seconds,
            )
        except MiniAppAuthenticationError:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Telegram Mini App authentication failed.",
            ) from None
        if (
            runtime_settings.allowed_user_ids
            and verified.identity.user_id not in runtime_settings.allowed_user_ids
        ):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN, detail="Access is not allowed."
            )
        return verified.identity

    mini_app_identity_dependency = Depends(authenticated_identity)

    @app.get("/healthz", tags=["operations"])
    @app.get("/health", tags=["operations"])
    async def health() -> dict[str, str]:
        return {"status": "ok", "service": "chronicle-rift", "mode": runtime_settings.bot_mode}

    @app.get("/", include_in_schema=False)
    async def root() -> RedirectResponse:
        return RedirectResponse(url=f"{runtime_settings.mini_app_path}/")

    @app.get("/api/me", tags=["mini-app"])
    async def get_player(
        request: Request,
        identity: TelegramIdentity = mini_app_identity_dependency,
    ) -> dict[str, Any]:
        try:
            player = await request.app.state.game_service.player_view(identity)
        except DatabaseUnavailable:
            LOGGER.warning("Database unavailable while loading Mini App player")
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Game service unavailable."
            ) from None
        return {"player": player, "version": __version__}

    @app.post("/api/actions", tags=["mini-app"])
    async def play_action(
        payload: ActionRequest,
        request: Request,
        identity: TelegramIdentity = mini_app_identity_dependency,
    ) -> dict[str, Any]:
        try:
            turn = await request.app.state.game_service.take_turn(identity, payload.action)
        except GameBusyError:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT, detail="Game state changed; retry the action."
            ) from None
        except DatabaseUnavailable:
            LOGGER.warning("Database unavailable while saving Mini App action")
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Game service unavailable."
            ) from None
        return {
            "player": public_player_view(turn.player),
            "turn": {
                "action": turn.action,
                "summary": turn.summary,
                "narrative": turn.narrative,
                "victory": turn.victory,
                "effects": turn.effects or {},
            },
        }

    @app.post("/api/buy", tags=["mini-app"])
    async def buy_item(
        payload: BuyRequest,
        request: Request,
        identity: TelegramIdentity = mini_app_identity_dependency,
    ) -> dict[str, Any]:
        try:
            result = await request.app.state.game_service.buy_item(identity, payload.item_id)
        except GameBusyError:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Game state changed; retry the purchase.",
            ) from None
        except (DatabaseUnavailable, PurchaseError):
            LOGGER.warning("Database unavailable while completing Mini App purchase")
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Game service unavailable."
            ) from None
        return {
            "player": public_player_view(result.player),
            "turn": {
                "item_id": result.item_id,
                "item_name": result.item_name,
                "summary": result.summary,
                "success": result.success,
                "reason": result.reason,
            },
        }

    @app.post(runtime_settings.webhook_path, include_in_schema=False)
    async def telegram_webhook(request: Request) -> JSONResponse:
        if runtime_settings.bot_mode != "webhook":
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found.")
        if not webhook_secret_is_valid(
            request.headers.get("x-telegram-bot-api-secret-token"), runtime_settings.webhook_secret
        ):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden.")
        body = await request.body()
        if len(body) > _MAX_WEBHOOK_BYTES:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="Payload too large."
            )
        try:
            payload = json.loads(body)
            if not isinstance(payload, dict):
                raise ValueError("Telegram update must be an object")
            update = Update.de_json(payload, request.app.state.telegram_application.bot)
            if update is None:
                raise ValueError("Telegram update could not be parsed")
        except (json.JSONDecodeError, ValueError, TypeError):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid Telegram update."
            ) from None
        # Queue updates so Telegram gets a fast acknowledgement even when Groq narration is slow.
        await request.app.state.telegram_application.update_queue.put(update)
        return JSONResponse({"ok": True})

    webapp_directory = _webapp_directory()
    app.mount(
        runtime_settings.mini_app_path,
        StaticFiles(directory=webapp_directory, html=True),
        name="mini-app",
    )
    return app


def _webapp_directory() -> str:
    return str((Path(__file__).parent / "webapp").resolve())


app = create_app()
