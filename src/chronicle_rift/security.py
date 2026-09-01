"""Telegram Mini App initData and webhook verification helpers."""

from __future__ import annotations

import hashlib
import hmac
import json
import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import parse_qsl

from .identity import TelegramIdentity

_MAX_INIT_DATA_LENGTH = 8_192
_MAX_FUTURE_SKEW_SECONDS = 60


class MiniAppAuthenticationError(ValueError):
    """Raised when Telegram Mini App initData cannot be authenticated."""


@dataclass(frozen=True, slots=True)
class VerifiedInitData:
    """Server-verified Mini App data; never constructed from initDataUnsafe."""

    identity: TelegramIdentity
    auth_date: int
    query_id: str | None


def validate_mini_app_init_data(
    init_data: str,
    *,
    bot_token: str,
    max_age_seconds: int,
    now: int | None = None,
) -> VerifiedInitData:
    """Validate Telegram's HMAC signature, age, and authenticated user payload.

    This follows Telegram's documented WebAppData HMAC flow. The client-provided
    ``user`` is accepted only after its enclosing initData signature verifies.
    """
    if not init_data or len(init_data) > _MAX_INIT_DATA_LENGTH:
        raise MiniAppAuthenticationError("Missing or oversized Telegram initData.")
    if not bot_token:
        raise MiniAppAuthenticationError("Server authentication is unavailable.")

    try:
        pairs = parse_qsl(init_data, keep_blank_values=True, strict_parsing=True)
    except ValueError as exc:
        raise MiniAppAuthenticationError("Malformed Telegram initData.") from exc

    if not pairs or len({key for key, _ in pairs}) != len(pairs):
        raise MiniAppAuthenticationError("Duplicate or empty Telegram initData fields.")
    values = dict(pairs)
    supplied_hash = values.pop("hash", None)
    if not supplied_hash or len(supplied_hash) != 64:
        raise MiniAppAuthenticationError("Telegram initData hash is missing.")

    data_check_string = "\n".join(f"{key}={values[key]}" for key in sorted(values))
    secret_key = hmac.new(b"WebAppData", bot_token.encode("utf-8"), hashlib.sha256).digest()
    expected_hash = hmac.new(
        secret_key, data_check_string.encode("utf-8"), hashlib.sha256
    ).hexdigest()
    if not hmac.compare_digest(expected_hash, supplied_hash):
        raise MiniAppAuthenticationError("Telegram initData signature is invalid.")

    auth_date = _integer(values.get("auth_date"), field_name="auth_date")
    current_time = int(time.time()) if now is None else now
    if auth_date > current_time + _MAX_FUTURE_SKEW_SECONDS:
        raise MiniAppAuthenticationError("Telegram initData has an invalid timestamp.")
    if current_time - auth_date > max_age_seconds:
        raise MiniAppAuthenticationError("Telegram initData has expired.")

    identity = _identity_from_user(values.get("user"))
    return VerifiedInitData(
        identity=identity,
        auth_date=auth_date,
        query_id=values.get("query_id") or None,
    )


def webhook_secret_is_valid(received: str | None, expected: str | None) -> bool:
    """Compare Telegram webhook secret tokens without a timing oracle."""
    return bool(received and expected and hmac.compare_digest(received, expected))


def _integer(value: str | None, *, field_name: str) -> int:
    if value is None:
        raise MiniAppAuthenticationError(f"Telegram initData is missing {field_name}.")
    try:
        parsed = int(value)
    except ValueError as exc:
        raise MiniAppAuthenticationError(f"Telegram initData has an invalid {field_name}.") from exc
    if parsed <= 0:
        raise MiniAppAuthenticationError(f"Telegram initData has an invalid {field_name}.")
    return parsed


def _identity_from_user(raw_user: str | None) -> TelegramIdentity:
    if not raw_user:
        raise MiniAppAuthenticationError("Telegram initData is missing the user.")
    try:
        user: dict[str, Any] = json.loads(raw_user)
    except (TypeError, json.JSONDecodeError) as exc:
        raise MiniAppAuthenticationError("Telegram user data is malformed.") from exc
    if not isinstance(user, dict):
        raise MiniAppAuthenticationError("Telegram user data is malformed.")

    user_id = user.get("id")
    if not isinstance(user_id, int) or isinstance(user_id, bool) or user_id <= 0:
        raise MiniAppAuthenticationError("Telegram user ID is invalid.")
    first_name = user.get("first_name")
    if not isinstance(first_name, str) or not first_name.strip():
        raise MiniAppAuthenticationError("Telegram user name is invalid.")
    username = user.get("username")
    if username is not None and not isinstance(username, str):
        raise MiniAppAuthenticationError("Telegram username is invalid.")
    return TelegramIdentity(user_id=user_id, first_name=first_name, username=username or None)
