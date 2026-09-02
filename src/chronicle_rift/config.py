"""Typed, secret-safe environment configuration for ChronicleRift."""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
import re
from dataclasses import dataclass, field
from typing import Final, Literal
from urllib.parse import urlsplit

from dotenv import load_dotenv


class ConfigurationError(ValueError):
    """Raised when application configuration is incomplete or unsafe."""


_SECRET_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,256}$")
_PATH_PATTERN = re.compile(r"^/[A-Za-z0-9_./-]{1,128}$")
_LOG_LEVELS = frozenset({"CRITICAL", "ERROR", "WARNING", "INFO", "DEBUG"})

CONFIG_VARIABLES: Final[dict[str, str]] = {
    "BOT_TOKEN": "Required. Token created with @BotFather.",
    "MONGODB_URI": "Required. MongoDB Atlas or self-hosted MongoDB connection URI.",
    "GROQ_API_KEY": "Required. API key from console.groq.com.",
    "GROQ_MODEL": "Optional Groq model ID. Default: openai/gpt-oss-20b.",
    "GROQ_TTS_MODEL": (
        "Optional Groq text-to-speech model for the narrator's voice. "
        "Default: canopylabs/orpheus-v1-english."
    ),
    "GROQ_TTS_VOICE": "Optional Orpheus voice name for narration. Default: tara.",
    "MONGODB_DATABASE": "Optional MongoDB database name. Default: chronicle_rift.",
    "BOT_MODE": "webhook on Render; polling for a local development process.",
    "RENDER_EXTERNAL_URL": "Automatically set by Render. Do not create it manually.",
    "PUBLIC_BASE_URL": "Optional custom HTTPS URL override for webhooks and the Mini App.",
    "WEBHOOK_SECRET": (
        "Optional independent webhook secret; safely derived from BOT_TOKEN if omitted."
    ),
    "WEBHOOK_PATH": "Optional inbound webhook path. Default: /telegram/webhook.",
    "PORT": "HTTP port. Render automatically provides it.",
    "MINI_APP_PATH": "Static Mini App path. Default: /app.",
    "MINI_APP_URL": "Optional public HTTPS Mini App URL override; normally derived automatically.",
    "RICH_MESSAGES_ENABLED": (
        "Use native Telegram Rich Messages with normal-message fallback. Default: true."
    ),
    "MINI_APP_AUTH_MAX_AGE_SECONDS": "Maximum age for Telegram Mini App initData. Default: 3600.",
    "API_ID": "Optional Telegram API application ID. Not needed by this Bot API project.",
    "API_HASH": "Optional Telegram API application hash. Not needed by this Bot API project.",
    "ALLOWED_USER_IDS": "Optional comma-separated Telegram user-ID allow-list.",
    "OWNER_USER_ID": (
        "Optional Telegram user ID of the owner. The owner receives every feedback"
        " note and plays with everything unlocked for testing."
    ),
    "REPO_URL": (
        "Optional source repository URL shown on the bot home. "
        "Default: https://github.com/iamrita-ai/chronicle-rift."
    ),
    "LOG_LEVEL": "DEBUG, INFO, WARNING, ERROR, or CRITICAL. Default: INFO.",
}


@dataclass(frozen=True, slots=True)
class Settings:
    """Runtime settings; credential fields are hidden from accidental repr logging."""

    bot_token: str = field(repr=False)
    mongodb_uri: str = field(repr=False)
    groq_api_key: str = field(repr=False)
    groq_model: str = "openai/gpt-oss-20b"
    groq_tts_model: str = "canopylabs/orpheus-v1-english"
    groq_tts_voice: str = "tara"
    mongodb_database: str = "chronicle_rift"
    bot_mode: Literal["webhook", "polling"] = "polling"
    public_base_url: str | None = None
    webhook_path: str = "/telegram/webhook"
    webhook_secret: str | None = field(default=None, repr=False)
    port: int = 10000
    mini_app_path: str = "/app"
    mini_app_url_override: str | None = None
    rich_messages_enabled: bool = True
    mini_app_auth_max_age_seconds: int = 3600
    telegram_api_id: int | None = field(default=None, repr=False)
    telegram_api_hash: str | None = field(default=None, repr=False)
    allowed_user_ids: frozenset[int] = frozenset()
    owner_user_id: int | None = None
    repo_url: str = "https://github.com/iamrita-ai/chronicle-rift"
    log_level: str = "INFO"

    @property
    def webhook_url(self) -> str:
        if self.bot_mode != "webhook" or not self.public_base_url:
            raise ConfigurationError("Webhook mode requires a public HTTPS base URL.")
        return f"{self.public_base_url}{self.webhook_path}"

    @property
    def mini_app_url(self) -> str | None:
        if self.mini_app_url_override:
            return self.mini_app_url_override
        if self.public_base_url:
            return f"{self.public_base_url}{self.mini_app_path}"
        return None

    @property
    def rich_api_base_url(self) -> str:
        """The standard Bot API base used by the Rich Message REST adapter."""
        return "https://api.telegram.org"

    @classmethod
    def from_env(cls) -> Settings:
        """Load .env for local work; process environment wins on Render."""
        load_dotenv(override=False)

        bot_token = _required("BOT_TOKEN")
        mongodb_uri = _required("MONGODB_URI")
        if not mongodb_uri.startswith(("mongodb://", "mongodb+srv://")):
            raise ConfigurationError("MONGODB_URI must begin with mongodb:// or mongodb+srv://.")

        groq_api_key = _required("GROQ_API_KEY")
        groq_tts_voice = _optional("GROQ_TTS_VOICE") or "tara"
        if not _SECRET_PATTERN.fullmatch(groq_tts_voice.replace(" ", "")):
            raise ConfigurationError("GROQ_TTS_VOICE must be a simple voice name such as 'tara'.")
        public_base_url = _normalise_https_url(
            _optional("PUBLIC_BASE_URL") or _optional("RENDER_EXTERNAL_URL"),
            name="PUBLIC_BASE_URL",
        )
        bot_mode = _bot_mode(_optional("BOT_MODE"), public_base_url)

        webhook_path = _path("WEBHOOK_PATH", _optional("WEBHOOK_PATH") or "/telegram/webhook")
        mini_app_path = _path("MINI_APP_PATH", _optional("MINI_APP_PATH") or "/app")
        if webhook_path == "/" or mini_app_path == "/":
            raise ConfigurationError("WEBHOOK_PATH and MINI_APP_PATH cannot be the site root.")
        if webhook_path == mini_app_path:
            raise ConfigurationError("WEBHOOK_PATH and MINI_APP_PATH must be different.")
        webhook_secret = _optional("WEBHOOK_SECRET")
        if webhook_secret and not _SECRET_PATTERN.fullmatch(webhook_secret):
            raise ConfigurationError(
                "WEBHOOK_SECRET must contain 1-256 letters, numbers, underscores, or hyphens."
            )
        if bot_mode == "webhook":
            if not public_base_url:
                raise ConfigurationError(
                    "Webhook mode needs PUBLIC_BASE_URL; Render supplies "
                    "RENDER_EXTERNAL_URL automatically."
                )
            webhook_secret = webhook_secret or _derived_webhook_secret(bot_token)

        mini_app_url_override = _normalise_https_url(
            _optional("MINI_APP_URL"), name="MINI_APP_URL", allow_path=True
        )
        telegram_api_id = _optional_positive_integer("API_ID")
        telegram_api_hash = _optional("API_HASH")
        if (telegram_api_id is None) != (telegram_api_hash is None):
            raise ConfigurationError("API_ID and API_HASH must be set together.")

        log_level = (_optional("LOG_LEVEL") or "INFO").upper()
        if log_level not in _LOG_LEVELS:
            raise ConfigurationError(f"LOG_LEVEL must be one of: {', '.join(sorted(_LOG_LEVELS))}.")

        return cls(
            bot_token=bot_token,
            mongodb_uri=mongodb_uri,
            groq_api_key=groq_api_key,
            groq_model=_optional("GROQ_MODEL") or "openai/gpt-oss-20b",
            groq_tts_model=_optional("GROQ_TTS_MODEL") or "canopylabs/orpheus-v1-english",
            groq_tts_voice=groq_tts_voice,
            mongodb_database=_optional("MONGODB_DATABASE") or "chronicle_rift",
            bot_mode=bot_mode,
            public_base_url=public_base_url,
            webhook_path=webhook_path,
            webhook_secret=webhook_secret,
            port=_integer("PORT", 10000, minimum=1, maximum=65535),
            mini_app_path=mini_app_path,
            mini_app_url_override=mini_app_url_override,
            rich_messages_enabled=_boolean("RICH_MESSAGES_ENABLED", default=True),
            mini_app_auth_max_age_seconds=_integer(
                "MINI_APP_AUTH_MAX_AGE_SECONDS", 3600, minimum=60, maximum=86400
            ),
            telegram_api_id=telegram_api_id,
            telegram_api_hash=telegram_api_hash,
            allowed_user_ids=_user_ids(_optional("ALLOWED_USER_IDS")),
            owner_user_id=_owner_user_id(_optional("OWNER_USER_ID")),
            repo_url=_optional("REPO_URL") or "https://github.com/iamrita-ai/chronicle-rift",
            log_level=log_level,
        )


def _required(name: str) -> str:
    value = _optional(name)
    if not value:
        raise ConfigurationError(f"{name} is required.")
    return value


def _optional(name: str) -> str | None:
    value = os.getenv(name)
    if value is None:
        return None
    value = value.strip()
    return value or None


def _bot_mode(
    requested_mode: str | None, public_base_url: str | None
) -> Literal["webhook", "polling"]:
    if requested_mode == "webhook":
        return "webhook"
    if requested_mode == "polling":
        return "polling"
    if requested_mode:
        raise ConfigurationError("BOT_MODE must be 'webhook' or 'polling'.")
    return "webhook" if public_base_url else "polling"


def _integer(name: str, default: int, *, minimum: int, maximum: int) -> int:
    raw_value = _optional(name)
    if raw_value is None:
        return default
    try:
        value = int(raw_value)
    except ValueError as exc:
        raise ConfigurationError(f"{name} must be an integer.") from exc
    if not minimum <= value <= maximum:
        raise ConfigurationError(f"{name} must be between {minimum} and {maximum}.")
    return value


def _optional_positive_integer(name: str) -> int | None:
    raw_value = _optional(name)
    if raw_value is None:
        return None
    try:
        value = int(raw_value)
    except ValueError as exc:
        raise ConfigurationError(f"{name} must be an integer.") from exc
    if value <= 0:
        raise ConfigurationError(f"{name} must be a positive integer.")
    return value


def _boolean(name: str, *, default: bool) -> bool:
    raw_value = _optional(name)
    if raw_value is None:
        return default
    if raw_value.lower() in {"1", "true", "yes", "on"}:
        return True
    if raw_value.lower() in {"0", "false", "no", "off"}:
        return False
    raise ConfigurationError(f"{name} must be true or false.")


def _user_ids(raw_value: str | None) -> frozenset[int]:
    if raw_value is None:
        return frozenset()
    try:
        user_ids = frozenset(int(value.strip()) for value in raw_value.split(",") if value.strip())
    except ValueError as exc:
        raise ConfigurationError(
            "ALLOWED_USER_IDS must be a comma-separated list of integers."
        ) from exc
    if not user_ids or any(user_id <= 0 for user_id in user_ids):
        raise ConfigurationError("ALLOWED_USER_IDS must contain positive Telegram user IDs.")
    return user_ids


def _owner_user_id(raw_value: str | None) -> int | None:
    if raw_value is None or not raw_value.strip():
        return None
    try:
        owner_user_id = int(raw_value.strip())
    except ValueError as exc:
        raise ConfigurationError(
            "OWNER_USER_ID must be a single positive Telegram user ID."
        ) from exc
    if owner_user_id <= 0:
        raise ConfigurationError("OWNER_USER_ID must be a positive Telegram user ID.")
    return owner_user_id


def _path(name: str, value: str) -> str:
    if not _PATH_PATTERN.fullmatch(value):
        raise ConfigurationError(f"{name} must start with '/' and use URL-safe path characters.")
    normalised = value.rstrip("/") or "/"
    segments = normalised.split("/")[1:]
    if any(not segment or segment in {".", ".."} for segment in segments):
        raise ConfigurationError(f"{name} cannot contain empty, '.' or '..' path segments.")
    return normalised


def _normalise_https_url(value: str | None, *, name: str, allow_path: bool = False) -> str | None:
    if value is None:
        return None
    parts = urlsplit(value)
    if (
        parts.scheme != "https"
        or not parts.netloc
        or parts.username is not None
        or parts.password is not None
        or parts.query
        or parts.fragment
        or (not allow_path and parts.path not in {"", "/"})
    ):
        raise ConfigurationError(
            f"{name} must be a public HTTPS URL without credentials, query, or fragment."
        )
    return value.rstrip("/")


def _derived_webhook_secret(bot_token: str) -> str:
    """Return a stable Telegram-valid secret when WEBHOOK_SECRET is not supplied."""
    digest = hmac.new(
        bot_token.encode("utf-8"), b"chronicle-rift:webhook-secret:v1", hashlib.sha256
    ).digest()
    return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")
