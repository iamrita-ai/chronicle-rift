"""Game-state constructors and transport-safe player views."""

from __future__ import annotations

from copy import deepcopy
from datetime import UTC, datetime
from typing import Any

DEFAULT_ENEMY = {
    "name": "Ash Warden",
    "hp": 18,
    "max_hp": 18,
    "attack": 5,
    "art": "🔥",
}


def new_player(*, user_id: int, first_name: str, username: str | None) -> dict[str, Any]:
    """Build a new MongoDB player document with no untrusted executable state."""
    now = datetime.now(UTC)
    return {
        "_id": user_id,
        "profile": {
            "first_name": _clean_name(first_name),
            "username": username or None,
            "hero_name": _clean_name(first_name) or "Riftwalker",
        },
        "game": {
            "level": 1,
            "xp": 0,
            "gold": 25,
            "hp": 24,
            "max_hp": 24,
            "energy": 5,
            "max_energy": 5,
            "chapter": 1,
            "quest_title": "The Ember Gate",
            "quest_objective": "Break the Ash Warden's siege at the rift gate.",
            "enemy": deepcopy(DEFAULT_ENEMY),
            "inventory": ["Rift Compass", "Traveler's Tonic"],
            "last_narrative": "The Ember Gate shudders. Your first choice will shape the realm.",
        },
        "revision": 1,
        "created_at": now,
        "updated_at": now,
    }


def public_player_view(player: dict[str, Any]) -> dict[str, Any]:
    """Return only the Mini App fields that a player is allowed to see."""
    game = player["game"]
    enemy = game["enemy"]
    return {
        "hero": {
            "name": player["profile"]["hero_name"],
            "level": game["level"],
            "xp": game["xp"],
            "gold": game["gold"],
            "hp": game["hp"],
            "max_hp": game["max_hp"],
            "energy": game["energy"],
            "max_energy": game["max_energy"],
        },
        "quest": {
            "chapter": game["chapter"],
            "title": game["quest_title"],
            "objective": game["quest_objective"],
        },
        "enemy": {
            "name": enemy["name"],
            "hp": enemy["hp"],
            "max_hp": enemy["max_hp"],
            "art": enemy["art"],
        },
        "inventory": list(game["inventory"]),
        "narrative": game["last_narrative"],
        "revision": player["revision"],
    }


def _clean_name(value: str) -> str:
    return " ".join(value.split())[:32]
