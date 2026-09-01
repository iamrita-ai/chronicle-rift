"""Game-state constructors, the item catalogue, and transport-safe player views."""

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

BASE_MAX_HP = 24
BASE_MAX_ENERGY = 5
LEVEL_HP_GAIN = 4
LEVEL_XP_FACTOR = 20
MAX_RELIC_LEVEL = 5

# --------------------------------------------------------------------------- #
# ITEM CATALOGUE
#
# Three kinds of item:
#   consumable — bought or looted, stored in the satchel, used during a fight.
#   relic      — permanent gear that can be upgraded with coins (level 1..5).
#   treasure   — loot with no effect; its whole purpose is to be sold.
# Every entry carries its own artwork so the Mini App can show a picture.
# --------------------------------------------------------------------------- #
ITEMS: dict[str, dict[str, Any]] = {
    # ---------------- healing & support consumables ----------------
    "salve": {
        "name": "Ember Salve",
        "kind": "consumable",
        "rarity": "common",
        "emoji": "🩹",
        "art": "item-heal-small",
        "cost": 14,
        "sell": 5,
        "desc": "Restores 8 Vitality instantly.",
        "ability": "+8 HP",
        "effect": {"heal": 8},
    },
    "draught": {
        "name": "Healing Draught",
        "kind": "consumable",
        "rarity": "common",
        "emoji": "❤️",
        "art": "item-heal",
        "cost": 25,
        "sell": 9,
        "desc": "Restores 15 Vitality instantly.",
        "ability": "+15 HP",
        "effect": {"heal": 15},
    },
    "greater_draught": {
        "name": "Greater Draught",
        "kind": "consumable",
        "rarity": "rare",
        "emoji": "💖",
        "art": "item-heal-large",
        "cost": 45,
        "sell": 17,
        "desc": "Restores 30 Vitality instantly.",
        "ability": "+30 HP",
        "effect": {"heal": 30},
    },
    "regen_balm": {
        "name": "Emberweave Balm",
        "kind": "consumable",
        "rarity": "rare",
        "emoji": "🌿",
        "art": "item-regen",
        "cost": 35,
        "sell": 13,
        "desc": "Heals 5 Vitality at the start of each of your next 3 turns.",
        "ability": "Regeneration 5 x3",
        "effect": {"regen": 3},
    },
    "phoenix_tear": {
        "name": "Phoenix Tear",
        "kind": "consumable",
        "rarity": "legendary",
        "emoji": "🔥",
        "art": "item-phoenix",
        "cost": 95,
        "sell": 36,
        "desc": "Fully restores Vitality and Rift Energy.",
        "ability": "Full heal + full Energy",
        "effect": {"heal": 999, "energy": 999},
    },
    "elixir": {
        "name": "Rift Elixir",
        "kind": "consumable",
        "rarity": "common",
        "emoji": "⚡",
        "art": "item-elixir",
        "cost": 20,
        "sell": 7,
        "desc": "Restores 3 Rift Energy.",
        "ability": "+3 Energy",
        "effect": {"energy": 3},
    },
    "clarity": {
        "name": "Clarity Tonic",
        "kind": "consumable",
        "rarity": "rare",
        "emoji": "🎯",
        "art": "item-focus",
        "cost": 28,
        "sell": 10,
        "desc": "Fills your Focus meter for a devastating next Strike.",
        "ability": "Focus to maximum",
        "effect": {"focus": 3},
    },
    "bomb": {
        "name": "Rift Grenade",
        "kind": "consumable",
        "rarity": "rare",
        "emoji": "💣",
        "art": "item-bomb",
        "cost": 32,
        "sell": 12,
        "desc": "Hurls raw rift-fire for 12 damage — it cannot be blocked.",
        "ability": "12 direct damage",
        "effect": {"damage": 12},
    },
    "smoke": {
        "name": "Veil Powder",
        "kind": "consumable",
        "rarity": "epic",
        "emoji": "🌫",
        "art": "item-smoke",
        "cost": 40,
        "sell": 15,
        "desc": "Blinds the enemy: it misses its next telegraphed move entirely.",
        "ability": "Skip the enemy's next attack",
        "effect": {"stun": 1},
    },
    # ---------------- permanent, upgradeable relics ----------------
    "blade": {
        "name": "Rift Steel",
        "kind": "relic",
        "rarity": "epic",
        "emoji": "⚔️",
        "art": "item-blade",
        "cost": 60,
        "sell": 0,
        "upgrade_base": 45,
        "desc": "A rune-forged edge that bites deeper every time it is reforged.",
        "ability": "+2 Strike damage per level",
        "per_level": {"attack": 2},
    },
    "ward": {
        "name": "Aegis Sigil",
        "kind": "relic",
        "rarity": "epic",
        "emoji": "🛡",
        "art": "item-ward",
        "cost": 60,
        "sell": 0,
        "upgrade_base": 45,
        "desc": "A sigil that thickens your ward against telegraphed blows.",
        "ability": "+2 Ward strength per level",
        "per_level": {"ward": 2},
    },
    "charm": {
        "name": "Luck Charm",
        "kind": "relic",
        "rarity": "rare",
        "emoji": "🍀",
        "art": "item-charm",
        "cost": 40,
        "sell": 0,
        "upgrade_base": 35,
        "desc": "Fortune leans closer with every leaf you add.",
        "ability": "+1 Scout insight per level",
        "per_level": {"luck": 1},
    },
    "heart": {
        "name": "Ember Heart",
        "kind": "relic",
        "rarity": "epic",
        "emoji": "💠",
        "art": "item-amulet",
        "cost": 70,
        "sell": 0,
        "upgrade_base": 50,
        "desc": "A caged coal that keeps beating long after you should have fallen.",
        "ability": "+5 maximum Vitality per level",
        "per_level": {"max_hp": 5},
    },
    "core": {
        "name": "Rift Core",
        "kind": "relic",
        "rarity": "legendary",
        "emoji": "🔷",
        "art": "item-core",
        "cost": 85,
        "sell": 0,
        "upgrade_base": 60,
        "desc": "A shard of the rift itself, feeding you extra Energy each fight.",
        "ability": "+1 maximum Rift Energy per level",
        "per_level": {"max_energy": 1},
    },
    # ---------------- treasure: loot that exists to be sold ----------------
    "ash_shard": {
        "name": "Ash Shard",
        "kind": "treasure",
        "rarity": "common",
        "emoji": "🪨",
        "art": "treasure-shard",
        "cost": None,
        "sell": 12,
        "desc": "Cooled rift-glass prised from a fallen warden. Merchants pay well.",
        "ability": "Sell for coins",
    },
    "rift_pearl": {
        "name": "Rift Pearl",
        "kind": "treasure",
        "rarity": "rare",
        "emoji": "🔮",
        "art": "",
        "cost": None,
        "sell": 26,
        "desc": "A bead of condensed rift-light. Warm, heavy, and very valuable.",
        "ability": "Sell for coins",
    },
    "colossus_fang": {
        "name": "Colossus Fang",
        "kind": "treasure",
        "rarity": "epic",
        "emoji": "🦴",
        "art": "",
        "cost": None,
        "sell": 44,
        "desc": "Proof you outlived something enormous.",
        "ability": "Sell for coins",
    },
    "gilded_idol": {
        "name": "Gilded Idol",
        "kind": "treasure",
        "rarity": "legendary",
        "emoji": "🗿",
        "art": "",
        "cost": None,
        "sell": 75,
        "desc": "A guardian cast in old gold. Somebody, somewhere, wants it badly.",
        "ability": "Sell for coins",
    },
}

RARITY_ORDER = ("common", "rare", "epic", "legendary")

# What can drop when a chapter is cleared, by rarity tier.
LOOT_TABLE: dict[str, tuple[str, ...]] = {
    "common": ("salve", "elixir", "ash_shard", "draught"),
    "rare": ("greater_draught", "regen_balm", "clarity", "bomb", "rift_pearl"),
    "epic": ("smoke", "colossus_fang"),
    "legendary": ("phoenix_tear", "gilded_idol"),
}

RELIC_IDS = tuple(item_id for item_id, item in ITEMS.items() if item["kind"] == "relic")
BUYABLE_IDS = tuple(item_id for item_id, item in ITEMS.items() if item.get("cost"))

# Kept for backwards compatibility with older imports/tests.
SHOP_ITEMS: dict[str, dict[str, Any]] = {item_id: ITEMS[item_id] for item_id in BUYABLE_IDS}

# Legacy inventory strings that predate the catalogue, mapped onto real items.
LEGACY_NAMES = {
    "Healing Draught": "draught",
    "Rift Elixir": "elixir",
    "Rift Steel": "blade",
    "Aegis Sigil": "ward",
    "Luck Charm": "charm",
    "Traveler's Tonic": "salve",
    "Rift Compass": "ash_shard",
}

# Fields that newer versions expect on every player document.
GAME_DEFAULTS: dict[str, Any] = {
    "coins": 30,
    "points": 0,
    "attack_bonus": 0,
    "ward_bonus": 0,
    "luck": False,
    "luck_bonus": 0,
    "exposed_strikes": 0,
    "focus": 0,
    "burn": 0,
    "regen": 0,
    "stun": 0,
    "turn": 0,
    "base_max_hp": BASE_MAX_HP,
}


def relic_cost(item_id: str, level: int) -> int:
    """Coin cost to take a relic from ``level`` to ``level + 1``."""
    item = ITEMS[item_id]
    if level <= 0:
        return int(item["cost"])
    return int(item["upgrade_base"] * level)


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
            "hp": BASE_MAX_HP,
            "base_max_hp": BASE_MAX_HP,
            "max_hp": BASE_MAX_HP,
            "energy": BASE_MAX_ENERGY,
            "max_energy": BASE_MAX_ENERGY,
            "attack_bonus": 0,
            "ward_bonus": 0,
            "luck": False,
            "luck_bonus": 0,
            "exposed_strikes": 0,
            "focus": 0,
            "burn": 0,
            "regen": 0,
            "stun": 0,
            "turn": 0,
            "chapter": 1,
            "quest_title": "The Ember Gate",
            "quest_objective": "Empty the Ash Warden's HP bar to open Chapter 2.",
            "enemy": deepcopy(DEFAULT_ENEMY),
            # Satchel: {item_id: quantity}
            "inventory": {"salve": 2, "elixir": 1},
            # Gear: {relic_id: level}
            "relics": {},
            "purchased": [],
            "last_narrative": "The Ember Gate shudders. Your first choice will shape the realm.",
        },
        "revision": 1,
        "created_at": now,
        "updated_at": now,
    }


def ensure_game_defaults(player: dict[str, Any]) -> None:
    """Add defaults for missing fields and migrate older documents in place."""
    game = player.setdefault("game", {})
    for key, value in GAME_DEFAULTS.items():
        if key not in game:
            game[key] = deepcopy(value)

    relics = game.get("relics")
    if not isinstance(relics, dict):
        relics = {}
    # Legacy "purchased" list => level 1 relics.
    for legacy in game.get("purchased") or []:
        if legacy in RELIC_IDS:
            relics.setdefault(legacy, 1)
    game["relics"] = {k: int(v) for k, v in relics.items() if k in RELIC_IDS}

    inventory = game.get("inventory")
    if isinstance(inventory, list):  # legacy list[str]
        migrated: dict[str, int] = {}
        for entry in inventory:
            item_id = LEGACY_NAMES.get(str(entry))
            if item_id and ITEMS[item_id]["kind"] == "relic":
                game["relics"].setdefault(item_id, 1)
            elif item_id:
                migrated[item_id] = migrated.get(item_id, 0) + 1
        inventory = migrated
    if not isinstance(inventory, dict):
        inventory = {}
    game["inventory"] = {
        k: int(v) for k, v in inventory.items() if k in ITEMS and int(v) > 0
    }

    game.setdefault("purchased", [])
    enemy = game.setdefault("enemy", deepcopy(DEFAULT_ENEMY))
    enemy.setdefault("intent_index", 0)
    enemy.setdefault("boss", False)
    game.setdefault("base_max_hp", game.get("max_hp", BASE_MAX_HP))
    apply_relic_bonuses(game)


def apply_relic_bonuses(game: dict[str, Any]) -> None:
    """Recompute every derived stat from the hero's relic levels."""
    relics = game.get("relics") or {}
    totals = {"attack": 0, "ward": 0, "luck": 0, "max_hp": 0, "max_energy": 0}
    for item_id, level in relics.items():
        per_level = ITEMS[item_id].get("per_level", {})
        for stat, amount in per_level.items():
            totals[stat] += amount * int(level)
    game["attack_bonus"] = totals["attack"]
    game["ward_bonus"] = totals["ward"]
    game["luck_bonus"] = totals["luck"]
    game["luck"] = totals["luck"] > 0
    game["max_hp"] = int(game.get("base_max_hp", BASE_MAX_HP)) + totals["max_hp"]
    game["max_energy"] = BASE_MAX_ENERGY + totals["max_energy"]
    game["hp"] = min(int(game.get("hp", game["max_hp"])), game["max_hp"])
    game["energy"] = min(int(game.get("energy", game["max_energy"])), game["max_energy"])


def add_item(game: dict[str, Any], item_id: str, quantity: int = 1) -> None:
    """Put a consumable or treasure into the satchel."""
    if item_id not in ITEMS or quantity <= 0:
        return
    inventory = game.setdefault("inventory", {})
    inventory[item_id] = int(inventory.get(item_id, 0)) + quantity


def remove_item(game: dict[str, Any], item_id: str, quantity: int = 1) -> bool:
    """Take items out of the satchel; returns False when there are not enough."""
    inventory = game.setdefault("inventory", {})
    held = int(inventory.get(item_id, 0))
    if held < quantity:
        return False
    if held == quantity:
        inventory.pop(item_id, None)
    else:
        inventory[item_id] = held - quantity
    return True


def level_threshold(game: dict[str, Any]) -> int:
    """XP required to reach the next level."""
    return int(game.get("level", 1)) * LEVEL_XP_FACTOR


def level_progress(game: dict[str, Any]) -> float:
    """Fraction (0.0..1.0) of the current level's XP that the hero has earned."""
    threshold = max(level_threshold(game), 1)
    return max(0.0, min(1.0, float(game.get("xp", 0)) / threshold))


def item_card(item_id: str, *, quantity: int = 0, level: int = 0) -> dict[str, Any]:
    """A single transport-safe item description for the Mini App and the bot."""
    item = ITEMS[item_id]
    card = {
        "id": item_id,
        "name": item["name"],
        "kind": item["kind"],
        "rarity": item["rarity"],
        "emoji": item["emoji"],
        "art": item.get("art", ""),
        "desc": item["desc"],
        "ability": item["ability"],
        "cost": item.get("cost"),
        "sell": int(item.get("sell", 0)),
    }
    if item["kind"] == "relic":
        card["level"] = level
        card["max_level"] = MAX_RELIC_LEVEL
        card["owned"] = level > 0
        card["next_cost"] = relic_cost(item_id, level) if level < MAX_RELIC_LEVEL else None
        card["bonus_now"] = _relic_bonus_text(item_id, level)
        card["bonus_next"] = (
            _relic_bonus_text(item_id, level + 1) if level < MAX_RELIC_LEVEL else None
        )
    else:
        card["quantity"] = quantity
    return card


def inventory_view(game: dict[str, Any]) -> list[dict[str, Any]]:
    """Satchel contents, rarest first, for the inventory screen."""
    inventory = game.get("inventory") or {}
    cards = [item_card(item_id, quantity=qty) for item_id, qty in inventory.items()]
    cards.sort(key=lambda card: (-RARITY_ORDER.index(card["rarity"]), card["name"]))
    return cards


def relics_view(game: dict[str, Any]) -> list[dict[str, Any]]:
    """Every relic in the game with the hero's current level in it."""
    relics = game.get("relics") or {}
    return [item_card(item_id, level=int(relics.get(item_id, 0))) for item_id in RELIC_IDS]


def public_player_view(player: dict[str, Any]) -> dict[str, Any]:
    """Return only the Mini App fields that a player is allowed to see."""
    # Imported lazily: game_engine imports this module, so a top-level import
    # would create a cycle.
    from .game_engine import MAX_FOCUS, STRIKE_MIN, sync_intent

    ensure_game_defaults(player)
    game = player["game"]
    enemy = game["enemy"]
    intent = sync_intent(enemy)
    threshold = level_threshold(game)
    shop = [item_card(item_id, level=int((game.get("relics") or {}).get(item_id, 0)))
            for item_id in BUYABLE_IDS]
    inventory = inventory_view(game)
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
            "luck_bonus": game.get("luck_bonus", 0),
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
            "regen": int(game.get("regen", 0)),
            "stun": int(game.get("stun", 0)),
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
        "inventory": inventory,
        "inventory_value": sum(card["sell"] * card["quantity"] for card in inventory),
        "relics": relics_view(game),
        "shop": shop,
        "narrative": game["last_narrative"],
        "revision": player["revision"],
    }


def _relic_bonus_text(item_id: str, level: int) -> str:
    if level <= 0:
        return "Not owned"
    labels = {
        "attack": "Strike damage",
        "ward": "Ward strength",
        "luck": "Scout insight",
        "max_hp": "max Vitality",
        "max_energy": "max Rift Energy",
    }
    parts = [
        f"+{amount * level} {labels[stat]}"
        for stat, amount in ITEMS[item_id].get("per_level", {}).items()
    ]
    return " · ".join(parts)


def _clean_name(value: str) -> str:
    return " ".join(value.split())[:32]
