"""Groq-backed, bounded narration for game turns."""

from __future__ import annotations

import logging
import re
from typing import Any

from groq import APIError, AsyncGroq

from .config import Settings

LOGGER = logging.getLogger(__name__)
_MAX_NARRATIVE_CHARACTERS = 650


class GroqNarrator:
    """Produces short cinematic flavor text; core game rules remain server-side."""

    def __init__(self, settings: Settings) -> None:
        self._client = AsyncGroq(api_key=settings.groq_api_key)
        self._model = settings.groq_model

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
