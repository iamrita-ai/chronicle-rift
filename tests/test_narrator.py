"""The narrator's Orpheus voice: bounded, failure-tolerant TTS."""

from __future__ import annotations

import httpx
import pytest

from chronicle_rift.config import Settings
from chronicle_rift.narrator import GroqNarrator


def _narrator() -> GroqNarrator:
    settings = Settings(
        bot_token="123:test",
        mongodb_uri="mongodb://localhost:27017",
        groq_api_key="test-key",
        bot_mode="polling",
    )
    return GroqNarrator(settings)


class _FakeResponse:
    def __init__(self, status_code: int, content: bytes) -> None:
        self.status_code = status_code
        self.content = content


class _FakeClient:
    def __init__(self, response: _FakeResponse | Exception, *, recorder: list) -> None:
        self._response = response
        self._recorder = recorder

    async def __aenter__(self) -> _FakeClient:
        return self

    async def __aexit__(self, *exc_info) -> None:
        return None

    async def post(self, url, headers=None, json=None):
        self._recorder.append({"url": url, "headers": headers, "json": json})
        if isinstance(self._response, Exception):
            raise self._response
        return self._response


@pytest.mark.asyncio
async def test_synthesize_posts_the_configured_orpheus_model(monkeypatch) -> None:
    narrator = _narrator()
    calls: list[dict] = []
    fake = _FakeClient(_FakeResponse(200, b"ID3mp3-bytes"), recorder=calls)
    monkeypatch.setattr("chronicle_rift.narrator.httpx.AsyncClient", lambda **kw: fake)

    audio = await narrator.synthesize("Fire meets shadow on the ridge.")

    assert audio == b"ID3mp3-bytes"
    (call,) = calls
    assert call["url"] == "https://api.groq.com/openai/v1/audio/speech"
    assert call["headers"]["Authorization"] == "Bearer test-key"
    assert call["json"]["model"] == "canopylabs/orpheus-v1-english"
    assert call["json"]["voice"] == "tara"
    assert call["json"]["response_format"] == "mp3"
    assert call["json"]["input"].startswith("Fire meets shadow")


@pytest.mark.asyncio
async def test_synthesize_caps_and_collapses_the_passage(monkeypatch) -> None:
    narrator = _narrator()
    calls: list[dict] = []
    fake = _FakeClient(_FakeResponse(200, b"mp3"), recorder=calls)
    monkeypatch.setattr("chronicle_rift.narrator.httpx.AsyncClient", lambda **kw: fake)

    await narrator.synthesize("  word   \n word  " * 100)

    spoken = calls[0]["json"]["input"]
    assert " \n " not in spoken and "  " not in spoken
    assert len(spoken) <= 500


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "outcome",
    [
        _FakeResponse(500, b""),
        _FakeResponse(200, b""),
        httpx.ConnectError("connection reset"),
    ],
)
async def test_synthesize_returns_none_instead_of_raising(monkeypatch, outcome) -> None:
    narrator = _narrator()
    calls: list[dict] = []
    fake = _FakeClient(outcome, recorder=calls)
    monkeypatch.setattr("chronicle_rift.narrator.httpx.AsyncClient", lambda **kw: fake)

    assert await narrator.synthesize("Anything at all.") is None


@pytest.mark.asyncio
async def test_synthesize_skips_empty_text_without_calling_groq(monkeypatch) -> None:
    narrator = _narrator()

    def boom(**kwargs):  # pragma: no cover - must not be reached
        raise AssertionError("no request should be made for empty text")

    monkeypatch.setattr("chronicle_rift.narrator.httpx.AsyncClient", boom)
    assert await narrator.synthesize("   ") is None
