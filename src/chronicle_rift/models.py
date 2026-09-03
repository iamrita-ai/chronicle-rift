"""Game-state constructors, the item catalogue, and transport-safe player views."""

from __future__ import annotations

from copy import deepcopy
from datetime import UTC, datetime
from typing import Any

DEFAULT_ENEMY = {
    "id": "ash_warden",
    "name": "Ash Warden",
    "hp": 34,
    "max_hp": 34,
    "attack": 7,
    "art": "🔥",
    "sprite": "mob-ash-warden",
    "element": "fire",
    "ability": "Cinder Aura",
    "level": 1,
    "boss": False,
    # Index into the enemy's fixed, telegraphed attack rotation.
    "intent_index": 0,
}

BASE_MAX_HP = 24  # legacy floor; real vitality comes from the character spec
BASE_MAX_ENERGY = 5
LEVEL_HP_GAIN = 8

# --------------------------------------------------------------------------- #
# Trainable powers: every boss defeat grants attribute points, and each power
# can also be ground up with coins. Levels are tracked separately per power,
# each caps at 100, and the coin price climbs with every level.
# --------------------------------------------------------------------------- #
MAX_ATTR_LEVEL = 100
ATTR_COIN_BASE = 20
ATTR_COIN_STEP = 8
ATTRIBUTES: dict[str, dict[str, Any]] = {
    "strength": {
        "name": "Strength",
        "icon": "⚔️",
        "desc": "+2 attack power per level",
    },
    "stamina": {
        "name": "Stamina",
        "icon": "🛡️",
        "desc": "+2 defense and +1 energy per 10 levels",
    },
    "health": {
        "name": "Health",
        "icon": "❤️",
        "desc": "+12 max HP per level",
    },
    "speed": {
        "name": "Speed",
        "icon": "⚡",
        "desc": "+1 luck per level (crit & haste)",
    },
}


def attribute_coin_cost(level: int) -> int:
    """Rising coin price to take an attribute from ``level`` to ``level + 1``."""
    return ATTR_COIN_BASE + ATTR_COIN_STEP * max(0, int(level))


def attributes_of(game: dict[str, Any]) -> dict[str, int]:
    """Sanitized attribute levels (0..MAX_ATTR_LEVEL) for a game state."""
    raw = game.get("attributes")
    raw = raw if isinstance(raw, dict) else {}
    return {
        aid: max(0, min(MAX_ATTR_LEVEL, int(raw.get(aid, 0) or 0)))
        for aid in ATTRIBUTES
    }
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
    "arena_wins": 0,
    "arena_losses": 0,
    "boss_kills": 0,
    "best_chapter": 1,
    "attr_points": 0,
    "attributes": {"strength": 0, "stamina": 0, "health": 0, "speed": 0},
    "seen_monsters": [],
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
            "attr_points": 0,
            "attributes": {"strength": 0, "stamina": 0, "health": 0, "speed": 0},
            "seen_monsters": [DEFAULT_ENEMY["id"]],
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
            "character": DEFAULT_CHARACTER,
            "owned_characters": [DEFAULT_CHARACTER],
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
    if game.get("character") not in CHARACTERS:
        game["character"] = DEFAULT_CHARACTER
    owned = game.get("owned_characters")
    if not isinstance(owned, list) or not owned:
        owned = [DEFAULT_CHARACTER]
    game["owned_characters"] = [c for c in dict.fromkeys(owned) if c in CHARACTERS]
    if game["character"] not in game["owned_characters"]:
        game["owned_characters"].append(game["character"])
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
    game["inventory"] = {k: int(v) for k, v in inventory.items() if k in ITEMS and int(v) > 0}

    game.setdefault("purchased", [])
    game["attributes"] = attributes_of(game)
    enemy = game.setdefault("enemy", deepcopy(DEFAULT_ENEMY))
    enemy.setdefault("intent_index", 0)
    enemy.setdefault("boss", False)
    seen = game.get("seen_monsters")
    if not isinstance(seen, list):
        seen = []
    seen = [m for m in seen if isinstance(m, str)]
    if not seen:
        enemy_id = str(enemy.get("id") or "")
        if not enemy_id and enemy.get("sprite"):
            enemy_id = str(enemy["sprite"]).removeprefix("mob-").replace("-", "_")
        if enemy_id in MONSTERS:
            seen = [enemy_id]
    game["seen_monsters"] = seen[-64:]
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
    attrs = attributes_of(game)
    game["attack_bonus"] = totals["attack"] + attrs["strength"] * 2
    game["ward_bonus"] = totals["ward"] + attrs["stamina"] * 2
    game["luck_bonus"] = totals["luck"] + attrs["speed"]
    game["luck"] = (totals["luck"] + attrs["speed"]) > 0
    character = character_of(game)
    hero_level = max(1, int(game.get("level", 1)))
    game["power"] = int(character["power"])
    game["base_max_hp"] = int(character["hp"]) + LEVEL_HP_GAIN * (hero_level - 1)
    game["max_hp"] = game["base_max_hp"] + totals["max_hp"] + attrs["health"] * 12
    game["max_energy"] = (
        int(character["energy"]) + totals["max_energy"] + attrs["stamina"] // 10
    )
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
    attrs = attributes_of(game)
    shop = [
        item_card(item_id, level=int((game.get("relics") or {}).get(item_id, 0)))
        for item_id in BUYABLE_IDS
    ]
    inventory = inventory_view(game)
    character = character_card(game["character"], game)
    return {
        "owner": bool(game.get("owner_mode")),
        "profile": {
            "first_name": player["profile"]["first_name"],
            "username": player["profile"].get("username"),
            "hero_name": player["profile"]["hero_name"],
        },
        "record": {
            "wins": int(game.get("arena_wins", 0)),
            "losses": int(game.get("arena_losses", 0)),
            "boss_kills": int(game.get("boss_kills", 0)),
            "chapter": game["chapter"],
            "best_chapter": int(game.get("best_chapter", 1)),
        },
        "character": character,
        "roster": [character_card(cid, game) for cid in CHARACTERS],
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
            "power": int(game.get("power", 0)),
        },
        "attributes": {
            "points": int(game.get("attr_points", 0)),
            "max_level": MAX_ATTR_LEVEL,
            "list": [
                {
                    "id": aid,
                    "name": spec["name"],
                    "icon": spec["icon"],
                    "desc": spec["desc"],
                    "level": lvl,
                    "max": MAX_ATTR_LEVEL,
                    "coin_cost": attribute_coin_cost(lvl) if lvl < MAX_ATTR_LEVEL else None,
                }
                for aid, spec in ATTRIBUTES.items()
                for lvl in (attrs[aid],)
            ],
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
            "sprite": enemy.get("sprite", "mob-ash-warden"),
            "element": enemy.get("element", "fire"),
            "element_color": ELEMENTS.get(enemy.get("element", "fire"), ELEMENTS["fire"])["color"],
            "ability": enemy.get("ability", ""),
            "level": enemy.get("level", game["chapter"]),
            "boss": bool(enemy.get("boss", False)),
            "returning": bool(enemy.get("returning", False)),
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


# --------------------------------------------------------------------------- #
# PLAYABLE CHARACTERS
#
# Every hero has an element, three distinct attacks and its own base stats.
# The starter is free; the rest are bought with coins and kept forever.
# --------------------------------------------------------------------------- #
ELEMENTS: dict[str, dict[str, str]] = {
    "fire": {"name": "Fire", "color": "#ff8a3c", "status": "Burn"},
    "ice": {"name": "Snow", "color": "#7fd8ff", "status": "Freeze"},
    "wind": {"name": "Wind", "color": "#8ef0a8", "status": "Gale"},
    "arcane": {"name": "Magic", "color": "#b48bff", "status": "Siphon"},
    "shadow": {"name": "Shadow", "color": "#ff6ac1", "status": "Drain"},
}

CHARACTERS: dict[str, dict[str, Any]] = {
    "emberblade": {
        "name": "Emberblade",
        "title": "Ash-Sworn Vanguard",
        "element": "fire",
        "art": "char-emberblade",
        "cost": 0,
        "hp": 24,
        "energy": 5,
        "power": 1,
        "blurb": "A balanced brawler whose specials set the enemy alight.",
        "attacks": {
            "strike": {
                "name": "Ember Slash",
                "cost": 1,
                "min": 4,
                "max": 8,
                "desc": "Quick, reliable cut.",
            },
            "heavy": {
                "name": "Molten Cleave",
                "cost": 2,
                "min": 7,
                "max": 13,
                "desc": "Slow, heavy, and loud.",
            },
            "special": {
                "name": "Cinder Wave",
                "cost": 3,
                "min": 5,
                "max": 10,
                "desc": "Sets the enemy BURNING for 3 turns.",
            },
        },
    },
    "frostward": {
        "name": "Frostward",
        "title": "Warden of the Still Cold",
        "element": "ice",
        "art": "char-frostward",
        "cost": 260,
        "hp": 30,
        "energy": 4,
        "power": 0,
        "blurb": "Tanky. Her special freezes the enemy so it loses a whole turn.",
        "attacks": {
            "strike": {
                "name": "Rime Jab",
                "cost": 1,
                "min": 3,
                "max": 7,
                "desc": "Chilling quick hit.",
            },
            "heavy": {
                "name": "Glacier Smash",
                "cost": 2,
                "min": 8,
                "max": 14,
                "desc": "Crushing overhead blow.",
            },
            "special": {
                "name": "Deep Freeze",
                "cost": 3,
                "min": 4,
                "max": 8,
                "desc": "FREEZES the enemy: it misses its next move.",
            },
        },
    },
    "stormcaller": {
        "name": "Stormcaller",
        "title": "Dancer on the Gale",
        "element": "wind",
        "art": "char-stormcaller",
        "cost": 420,
        "hp": 22,
        "energy": 6,
        "power": 1,
        "blurb": "Fast and cheap to run: the special strikes twice and gives Energy back.",
        "attacks": {
            "strike": {
                "name": "Twin Slice",
                "cost": 1,
                "min": 4,
                "max": 9,
                "desc": "Two quick daggers.",
            },
            "heavy": {
                "name": "Cyclone Kick",
                "cost": 2,
                "min": 6,
                "max": 12,
                "desc": "Spinning wind blow.",
            },
            "special": {
                "name": "Gale Flurry",
                "cost": 3,
                "min": 4,
                "max": 8,
                "desc": "Hits twice and refunds 2 Rift Energy.",
            },
        },
    },
    "arcanist": {
        "name": "Arcanist",
        "title": "Reader of the Rift",
        "element": "arcane",
        "art": "char-arcanist",
        "cost": 640,
        "hp": 22,
        "energy": 6,
        "power": 2,
        "blurb": "Glass cannon. Her special pierces wards and heals her for half the damage.",
        "attacks": {
            "strike": {
                "name": "Rune Bolt",
                "cost": 1,
                "min": 5,
                "max": 9,
                "desc": "Focused arcane dart.",
            },
            "heavy": {
                "name": "Sigil Burst",
                "cost": 2,
                "min": 7,
                "max": 14,
                "desc": "Detonating glyph.",
            },
            "special": {
                "name": "Mind Siphon",
                "cost": 3,
                "min": 6,
                "max": 11,
                "desc": "Unblockable, and heals you for half the damage dealt.",
            },
        },
    },
    "voidreaper": {
        "name": "Voidreaper",
        "title": "The Last Quiet Thing",
        "element": "shadow",
        "art": "char-voidreaper",
        "cost": 950,
        "hp": 26,
        "energy": 5,
        "power": 3,
        "blurb": "Late-game monster: the special drains life and charges Focus instantly.",
        "attacks": {
            "strike": {
                "name": "Reap",
                "cost": 1,
                "min": 5,
                "max": 10,
                "desc": "A clean scythe pull.",
            },
            "heavy": {
                "name": "Grave Arc",
                "cost": 2,
                "min": 8,
                "max": 15,
                "desc": "A wide, brutal sweep.",
            },
            "special": {
                "name": "Soul Harvest",
                "cost": 3,
                "min": 6,
                "max": 12,
                "desc": "Drains 40% of the damage as health and fills 2 Focus.",
            },
        },
    },
}

DEFAULT_CHARACTER = "emberblade"

# --------------------------------------------------------------------------- #
# ENEMY ROSTER — each monster has an element, its own toughness curve and a
# signature ability that appears in its telegraphed rotation.
# --------------------------------------------------------------------------- #
MONSTERS: dict[str, dict[str, Any]] = {
    "ash_warden": {
        "name": "Ash Warden",
        "element": "fire",
        "art": "mob-ash-warden",
        "emoji": "🔥",
        "hp": 34,
        "attack": 7,
        "hp_growth": 10,
        "attack_growth": 2,
        "ability": "Cinder Aura — its Heavy Blow leaves you scorched.",
        "pattern": ("slash", "slash", "heavy"),
    },
    "obsidian_herald": {
        "name": "Obsidian Herald",
        "element": "arcane",
        "art": "mob-obsidian-herald",
        "emoji": "🗿",
        "hp": 38,
        "attack": 7,
        "hp_growth": 10,
        "attack_growth": 2,
        "ability": "Rift Drain — siphons your Energy so you cannot swing.",
        "pattern": ("slash", "drain", "heavy"),
    },
    "rift_stalker": {
        "name": "Rift Stalker",
        "element": "shadow",
        "art": "mob-rift-stalker",
        "emoji": "🜂",
        "hp": 42,
        "attack": 8,
        "hp_growth": 11,
        "attack_growth": 2,
        "ability": "Mend — it knits itself back together if you let it.",
        "pattern": ("slash", "heavy", "mend"),
    },
    "frost_revenant": {
        "name": "Frost Revenant",
        "element": "ice",
        "art": "mob-frost-revenant",
        "emoji": "❄️",
        "hp": 50,
        "attack": 9,
        "hp_growth": 12,
        "attack_growth": 3,
        "ability": "Rime Grip — heavy, slow, and it drains Energy too.",
        "pattern": ("heavy", "slash", "drain"),
    },
    "ebon_colossus": {
        "name": "Ebon Colossus",
        "element": "shadow",
        "art": "mob-ebon-colossus",
        "emoji": "🌑",
        "hp": 90,
        "attack": 12,
        "hp_growth": 18,
        "attack_growth": 3,
        "boss": True,
        "ability": "Rift Quake — a boss slam that flattens an unguarded hero.",
        "pattern": ("slash", "heavy", "drain", "quake"),
    },
}

# Which monster guards which chapter (bosses every 5th).
CHAPTER_MONSTERS = ("ash_warden", "obsidian_herald", "rift_stalker", "frost_revenant")


def monster_for_chapter(chapter: int) -> str:
    if chapter % 5 == 0:
        return "ebon_colossus"
    return CHAPTER_MONSTERS[(chapter - 1) % len(CHAPTER_MONSTERS)]


def character_of(game: dict[str, Any]) -> dict[str, Any]:
    return CHARACTERS.get(
        str(game.get("character", DEFAULT_CHARACTER)), CHARACTERS[DEFAULT_CHARACTER]
    )


def character_card(character_id: str, game: dict[str, Any]) -> dict[str, Any]:
    character = CHARACTERS[character_id]
    owned = character_id in (game.get("owned_characters") or [DEFAULT_CHARACTER])
    element = ELEMENTS[character["element"]]
    return {
        "id": character_id,
        "name": character["name"],
        "title": character["title"],
        "element": character["element"],
        "element_name": element["name"],
        "element_color": element["color"],
        "status": element["status"],
        "art": character["art"],
        "cost": character["cost"],
        "hp": character["hp"],
        "energy": character["energy"],
        "power": character["power"],
        "blurb": character["blurb"],
        "owned": owned,
        "active": character_id == game.get("character", DEFAULT_CHARACTER),
        "attacks": [
            {
                "id": attack_id,
                "name": spec["name"],
                "cost": spec["cost"],
                "min": spec["min"],
                "max": spec["max"],
                "desc": spec["desc"],
            }
            for attack_id, spec in character["attacks"].items()
        ],
    }
