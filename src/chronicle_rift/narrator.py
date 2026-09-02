"""Groq-backed, bounded narration and voice for game turns."""

from __future__ import annotations

import logging
import re
from typing import Any

import httpx
from groq import APIError, AsyncGroq

from .config import Settings

LOGGER = logging.getLogger(__name__)
_MAX_NARRATIVE_CHARACTERS = 650
_MAX_SPEECH_CHARACTERS = 500
_GROQ_SPEECH_URL = "https://api.groq.com/openai/v1/audio/speech"


class GroqNarrator:
    """Produces short cinematic flavor text; core game rules remain server-side."""

    def __init__(self, settings: Settings) -> None:
        self._client = AsyncGroq(api_key=settings.groq_api_key)
        self._model = settings.groq_model
        self._api_key = settings.groq_api_key
        self._tts_model = settings.groq_tts_model
        self._tts_voice = settings.groq_tts_voice

    async def narrate(self, *, player: dict[str, Any], action: str, summary: str) -> str:
        """Generate a safe one-paragraph narration with a deterministic fallback."""
        game = player["game"]
        prompt = (
            f"Hero: {player['profile']['hero_name']}\n"
            f"Quest: {game['quest_title']}\n"
            f"Enemy: {game['enemy']['name']}\n"
            f"Action: {action}\n"
            f"Resolved mechanics: {summary}\n\n"
            "Write one atmospheric fantasy paragraph in second person. Keep it under 75 words. "
            "Do not change scores, invent rewards, use copyrighted characters, or include markdown."
        )
        try:
            response = await self._client.chat.completions.create(
                model=self._model,
                messages=[
                    {
                        "role": "system",
                        "content": (
                            "You are ChronicleRift's concise, original fantasy game narrator."
                        ),
                    },
                    {"role": "user", "content": prompt},
                ],
                temperature=0.85,
                max_completion_tokens=120,
            )
            content = response.choices[0].message.content or ""
            cleaned = _clean_narrative(content)
            if cleaned:
                return cleaned
        except APIError as exc:
            LOGGER.warning("Groq narration unavailable (type=%s)", type(exc).__name__)
        except Exception as exc:  # Third-party boundary: do not expose request content in logs.
            LOGGER.warning("Unexpected Groq narration failure (type=%s)", type(exc).__name__)

        return _fallback_narrative(action, summary)

    async def synthesize(self, text: str) -> bytes | None:
        """Speak a passage with Groq's Orpheus TTS; None when unavailable.

        The client never chooses the words — the server only ever voices its
        own stored narrative, bounded to keep latency and cost predictable.
        """
        cleaned = " ".join(text.split())[:_MAX_SPEECH_CHARACTERS]
        if not cleaned:
            return None
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(30.0, connect=10.0)) as client:
                response = await client.post(
                    _GROQ_SPEECH_URL,
                    headers={"Authorization": f"Bearer {self._api_key}"},
                    json={
                        "model": self._tts_model,
                        "voice": self._tts_voice,
                        "input": cleaned,
                        "response_format": "mp3",
                    },
                )
        except httpx.HTTPError:
            LOGGER.warning("Groq TTS request failed (type=HTTPError)")
            return None
        if response.status_code == 200 and response.content:
            return response.content
        LOGGER.warning("Groq TTS unavailable (status=%s)", response.status_code)
        return None

    async def close(self) -> None:
        await self._client.close()


def _clean_narrative(value: str) -> str:
    cleaned = " ".join(value.replace("\x00", "").split())
    cleaned = re.sub(r"[`*_#>|]", "", cleaned)
    return cleaned[:_MAX_NARRATIVE_CHARACTERS].strip()


def _fallback_narrative(action: str, summary: str) -> str:
    verbs = {
        "strike": "The rift answers your courage with a thunderous echo.",
        "guard": "Runes flare along your shield while ash swirls around the gate.",
        "scout": "You listen closely as the realm whispers through the fractured stone.",
        "rest": "For a quiet moment, the ember shrine holds back the endless dark.",
    }
    return f"{verbs.get(action, 'The rift shifts around you.')} {summary}"
