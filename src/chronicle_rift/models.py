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
    "boss": False,
    # Index into the enemy's fixed, telegraphed attack rotation.
    "intent_index": 0,
}

# Fields that newer versions expect on every player document. Keeping them here
# lets old documents be upgraded in place and lets the rest of the code use
# ``setdefault``-style access without raising KeyError.
GAME_DEFAULTS: dict[str, Any] = {
    "coins": 30,
    "points": 0,
    "attack_bonus": 0,
    "ward_bonus": 0,
    "luck": False,
    "exposed_strikes": 0,
    # Combo meter charged by Guard/Scout/Rest and spent by Strike.
    "focus": 0,
    # Remaining Burn ticks applied by a critical hit.
    "burn": 0,
    "turn": 0,
}

LEVEL_XP_FACTOR = 20


# The Marketplace: every item is spendable co-currency sink. Consumables apply an
# instant effect; permanent upgrades stack with the hero's base combat values.
SHOP_ITEMS: dict[str, dict[str, Any]] = {
    "heal": {
        "art": "item-heal",
        "name": "Healing Draught",
        "emoji": "❤️",
        "cost": 25,
        "kind": "consumable",
        "desc": "Instantly restores 15 Vitality (never above your maximum).",
    },
    "elixir": {
        "art": "item-elixir",
        "name": "Rift Elixir",
        "emoji": "⚡",
        "cost": 20,
        "kind": "consumable",
        "desc": "Instantly restores 3 Rift Energy.",
    },
    "blade": {
        "art": "item-blade",
        "name": "Rift Steel",
        "emoji": "⚔️",
        "cost": 60,
        "kind": "upgrade",
        "desc": "Permanently grants +2 Strike damage.",
    },
    "ward": {
        "art": "item-ward",
        "name": "Aegis Sigil",
        "emoji": "🛡",
        "cost": 60,
        "kind": "upgrade",
        "desc": "Permanently grants +2 Ward strength.",
    },
    "charm": {
        "art": "item-charm",
        "name": "Luck Charm",
        "emoji": "🍀",
        "cost": 40,
        "kind": "upgrade",
        "desc": "Permanently grants +1 bonus insight from Scouting.",
    },
}


def new_player(*, user_id: int, first_name: str, username: str | None) -> dict[str, Any]:
    """Build a new MongoDB player document with no untrusted executable state."""
    now = datetime.now(UTC)
    name = _clean_name(first_name)
    return {
        "_id": user_id,
        "profile": {
            "first_name": name,
            "username": username or None,
            "hero_name": name or "Riftwalker",
        },
        "game": {
            "level": 1,
            "xp": 0,
            "gold": 25,
            "coins": 30,
            "points": 0,
            "hp": 24,
            "max_hp": 24,
            "energy": 5,
            "max_energy": 5,
            "attack_bonus": 0,
            "ward_bonus": 0,
            "luck": False,
            "focus": 0,
            "burn": 0,
            "turn": 0,
            "chapter": 1,
            "quest_title": "The Ember Gate",
            "quest_objective": "Empty the Ash Warden's HP bar to open Chapter 2.",
            "enemy": deepcopy(DEFAULT_ENEMY),
            "inventory": ["Rift Compass", "Traveler's Tonic"],
            "purchased": [],
            "last_narrative": "The Ember Gate shudders. Your first choice will shape the realm.",
        },
        "revision": 1,
        "created_at": now,
        "updated_at": now,
    }


def ensure_game_defaults(player: dict[str, Any]) -> None:
    """Add defaults for any missing newer game fields (works on existing docs)."""
    game = player.setdefault("game", {})
    for key, value in GAME_DEFAULTS.items():
        if key not in game:
            game[key] = deepcopy(value)
    game.setdefault("inventory", [])
    game.setdefault("purchased", [])
    enemy = game.setdefault("enemy", deepcopy(DEFAULT_ENEMY))
    enemy.setdefault("intent_index", 0)
    enemy.setdefault("boss", False)


def level_threshold(game: dict[str, Any]) -> int:
    """XP required to reach the next level."""
    return int(game.get("level", 1)) * LEVEL_XP_FACTOR


def level_progress(game: dict[str, Any]) -> float:
    """Fraction (0.0..1.0) of the current level's XP that the hero has earned."""
    threshold = max(level_threshold(game), 1)
    return max(0.0, min(1.0, float(game.get("xp", 0)) / threshold))


def public_player_view(player: dict[str, Any]) -> dict[str, Any]:
    """Return only the Mini App fields that a player is allowed to see."""
    # Imported lazily: game_engine imports this module, so a top-level import
    # would create a cycle.
    from .game_engine import (
        MAX_FOCUS,
        STRIKE_MIN,
        sync_intent,
    )

    ensure_game_defaults(player)
    game = player["game"]
    enemy = game["enemy"]
    intent = sync_intent(enemy)
    threshold = level_threshold(game)
    shop = [
        {
            "id": item_id,
            "name": item["name"],
            "emoji": item["emoji"],
            "cost": item["cost"],
            "kind": item["kind"],
            "desc": item["desc"],
            "art": item.get("art", ""),
        }
        for item_id, item in SHOP_ITEMS.items()
    ]
    return {
        "hero": {
            "name": player["profile"]["hero_name"],
            "level": game["level"],
            "xp": game["xp"],
            "xp_to_next": max(0, threshold - int(game["xp"])),
            "progress": round(level_progress(game), 4),
            "gold": game["gold"],
            "coins": game["coins"],
            "points": game["points"],
            "hp": game["hp"],
            "max_hp": game["max_hp"],
            "energy": game["energy"],
            "max_energy": game["max_energy"],
            "attack_bonus": game["attack_bonus"],
            "ward_bonus": game["ward_bonus"],
            "luck": game["luck"],
            "focus": int(game.get("focus", 0)),
            "max_focus": MAX_FOCUS,
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
            "attack": enemy.get("attack", DEFAULT_ENEMY["attack"]),
            "art": enemy["art"],
            "boss": bool(enemy.get("boss", False)),
            "intent": intent,
        },
        "battle": {
            "exposed": bool(game.get("exposed_strikes", 0)),
            "burn": int(game.get("burn", 0)),
            "turn": int(game.get("turn", 0)),
            # True when even a minimum Strike roll would end this fight, so the
            # UI can shout "FINISH IT" instead of leaving players guessing.
            "can_finish": bool(
                game["energy"] > 0
                and enemy["hp"]
                <= STRIKE_MIN
                + int(game["level"])
                + int(game.get("attack_bonus", 0))
                + (2 if game.get("exposed_strikes", 0) else 0)
                + int(game.get("focus", 0)) * 2
            ),
        },
        "inventory": list(game["inventory"]),
        "shop": shop,
        "narrative": game["last_narrative"],
        "revision": player["revision"],
    }


def _clean_name(value: str) -> str:
    return " ".join(value.split())[:32]
