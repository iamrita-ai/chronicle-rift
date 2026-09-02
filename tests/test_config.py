from __future__ import annotations

import pytest

from chronicle_rift.config import ConfigurationError, Settings


def _set_required(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BOT_TOKEN", "123456:test-token")
    monkeypatch.setenv("MONGODB_URI", "mongodb://localhost:27017")
    monkeypatch.setenv("GROQ_API_KEY", "test-groq-key")


def test_defaults_to_polling_without_public_url(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_required(monkeypatch)
    monkeypatch.delenv("PUBLIC_BASE_URL", raising=False)
    monkeypatch.delenv("RENDER_EXTERNAL_URL", raising=False)
    monkeypatch.delenv("BOT_MODE", raising=False)

    settings = Settings.from_env()

    assert settings.bot_mode == "polling"
    assert settings.mini_app_url is None
    assert settings.rich_messages_enabled is True


def test_webhook_configuration_derives_a_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_required(monkeypatch)
    monkeypatch.setenv("BOT_MODE", "webhook")
    monkeypatch.setenv("PUBLIC_BASE_URL", "https://chronicle.example/")
    monkeypatch.delenv("WEBHOOK_SECRET", raising=False)

    settings = Settings.from_env()

    assert settings.webhook_url == "https://chronicle.example/telegram/webhook"
    assert settings.mini_app_url == "https://chronicle.example/app"
    assert settings.webhook_secret
    assert len(settings.webhook_secret) >= 32


def test_rejects_partial_mtproto_credentials(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_required(monkeypatch)
    monkeypatch.setenv("API_ID", "12345")
    monkeypatch.delenv("API_HASH", raising=False)

    with pytest.raises(ConfigurationError, match="set together"):
        Settings.from_env()


def test_rejects_same_webhook_and_mini_app_path(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_required(monkeypatch)
    monkeypatch.setenv("WEBHOOK_PATH", "/gateway")
    monkeypatch.setenv("MINI_APP_PATH", "/gateway")

    with pytest.raises(ConfigurationError, match="must be different"):
        Settings.from_env()


def test_rejects_public_base_url_with_a_path(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_required(monkeypatch)
    monkeypatch.setenv("PUBLIC_BASE_URL", "https://chronicle.example/not-a-base")

    with pytest.raises(ConfigurationError, match="public HTTPS URL"):
        Settings.from_env()


def test_allows_an_https_mini_app_url_with_a_path(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_required(monkeypatch)
    monkeypatch.setenv("MINI_APP_URL", "https://chronicle.example/app")

    assert Settings.from_env().mini_app_url == "https://chronicle.example/app"

def test_tts_defaults_to_orpheus_english_and_tara(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_required(monkeypatch)
    monkeypatch.delenv("GROQ_TTS_MODEL", raising=False)
    monkeypatch.delenv("GROQ_TTS_VOICE", raising=False)

    settings = Settings.from_env()

    assert settings.groq_tts_model == "canopylabs/orpheus-v1-english"
    assert settings.groq_tts_voice == "tara"


def test_tts_voice_can_be_overridden_with_a_simple_name(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_required(monkeypatch)
    monkeypatch.setenv("GROQ_TTS_MODEL", "canopylabs/orpheus-v1-english")
    monkeypatch.setenv("GROQ_TTS_VOICE", "leah")

    settings = Settings.from_env()

    assert settings.groq_tts_voice == "leah"


def test_tts_voice_rejects_injection_attempts(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_required(monkeypatch)
    monkeypatch.setenv("GROQ_TTS_VOICE", "tara'; drop table")

    with pytest.raises(ConfigurationError):
        Settings.from_env()
