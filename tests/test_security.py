from __future__ import annotations

import hashlib
import hmac
import json
from urllib.parse import urlencode

import pytest

from chronicle_rift.security import (
    MiniAppAuthenticationError,
    validate_mini_app_init_data,
    webhook_secret_is_valid,
)

BOT_TOKEN = "123456:test-token"
NOW = 1_800_000_000


def signed_init_data(**overrides: str) -> str:
    fields = {
        "auth_date": str(NOW),
        "query_id": "AAEAAQ",
        "user": json.dumps(
            {"id": 42, "first_name": "Rita", "username": "riftwalker"},
            separators=(",", ":"),
        ),
        **overrides,
    }
    data_check_string = "\n".join(f"{key}={fields[key]}" for key in sorted(fields))
    secret = hmac.new(b"WebAppData", BOT_TOKEN.encode(), hashlib.sha256).digest()
    fields["hash"] = hmac.new(secret, data_check_string.encode(), hashlib.sha256).hexdigest()
    return urlencode(fields)


def test_validates_signed_mini_app_identity() -> None:
    verified = validate_mini_app_init_data(
        signed_init_data(), bot_token=BOT_TOKEN, max_age_seconds=3600, now=NOW
    )

    assert verified.identity.user_id == 42
    assert verified.identity.first_name == "Rita"
    assert verified.identity.username == "riftwalker"


def test_rejects_tampered_mini_app_identity() -> None:
    init_data = signed_init_data().replace("riftwalker", "intruder")

    with pytest.raises(MiniAppAuthenticationError, match="signature"):
        validate_mini_app_init_data(init_data, bot_token=BOT_TOKEN, max_age_seconds=3600, now=NOW)


def test_rejects_expired_mini_app_session() -> None:
    init_data = signed_init_data(auth_date=str(NOW - 3601))

    with pytest.raises(MiniAppAuthenticationError, match="expired"):
        validate_mini_app_init_data(init_data, bot_token=BOT_TOKEN, max_age_seconds=3600, now=NOW)


def test_rejects_duplicate_init_data_fields() -> None:
    init_data = signed_init_data() + "&auth_date=1"

    with pytest.raises(MiniAppAuthenticationError, match="Duplicate"):
        validate_mini_app_init_data(init_data, bot_token=BOT_TOKEN, max_age_seconds=3600, now=NOW)


def test_compares_webhook_secret_safely() -> None:
    assert webhook_secret_is_valid("expected", "expected") is True
    assert webhook_secret_is_valid("wrong", "expected") is False
    assert webhook_secret_is_valid(None, "expected") is False
