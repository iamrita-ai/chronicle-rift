"""Deterministic-friendly, side-effect-free tactical turn resolver."""

from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from random import SystemRandom
from typing import Any, Protocol

from .models import DEFAULT_ENEMY, SHOP_ITEMS, ensure_game_defaults

VALID_ACTIONS = frozenset({"strike", "guard", "scout", "rest"})


class RandomSource(Protocol):
    def randint(self, start: int, stop: int) -> int: ...


@dataclass(frozen=True, slots=True)
class TurnResolution:
    player: dict[str, Any]
    action: str
    summary: str
    victory: bool


@dataclass(frozen=True, slots=True)
class PurchaseResolution:
    player: dict[str, Any]
    item_id: str
    item_name: str
    summary: str
    success: bool
    reason: str | None = None


def resolve_turn(
    player: dict[str, Any], action: str, rng: RandomSource | None = None
) -> TurnResolution:
    """Resolve one action and return a new player document, never mutate input."""
    if action not in VALID_ACTIONS:
        raise ValueError("Unknown game action.")

    random_source = rng or SystemRandom()
    updated = deepcopy(player)
    ensure_game_defaults(updated)
    game = updated["game"]
    enemy = game["enemy"]
    if game["hp"] <= 0:
        game["hp"] = game["max_hp"]
        game["energy"] = max(1, game["max_energy"] // 2)
        summary = "You return to the rift camp, wounded but unbroken."
        game["last_narrative"] = summary
        return TurnResolution(updated, action, summary, victory=False)

    ward_strength = 0
    if action == "strike":
        if game["energy"] <= 0:
            summary = "Your blade is ready, but your energy is spent. Rest or scout first."
            game["last_narrative"] = summary
            return TurnResolution(updated, action, summary, victory=False)
        game["energy"] -= 1
        damage = random_source.randint(4, 8) + game["level"] + game.get("attack_bonus", 0)
        enemy["hp"] = max(0, enemy["hp"] - damage)
        summary = f"You strike for {damage} rift damage."
    elif action == "guard":
        ward_strength = random_source.randint(2, 5) + game.get("ward_bonus", 0)
        game["energy"] = min(game["max_energy"], game["energy"] + 1)
        summary = f"You raise a ward and prepare to absorb {ward_strength} damage."
    elif action == "scout":
        insight = random_source.randint(1, 3)
        if game.get("luck"):
            insight += 1
        game["xp"] += insight
        game["energy"] = min(game["max_energy"], game["energy"] + 1)
        summary = f"You read the rift winds and gain {insight} insight."
    else:  # rest
        healing = random_source.randint(4, 7)
        game["hp"] = min(game["max_hp"], game["hp"] + healing)
        game["energy"] = min(game["max_energy"], game["energy"] + 2)
        summary = f"You rest beside the ember shrine and recover {healing} HP."

    if enemy["hp"] <= 0:
        reward = 10 + game["chapter"] * 3
        coin_reward = 8 + game["chapter"] * 2
        point_reward = 20 + game["chapter"] * 5
        game["gold"] += reward
        game["coins"] += coin_reward
        game["points"] += point_reward
        game["xp"] += 12
        game["chapter"] += 1
        if game["xp"] >= game["level"] * 20:
            game["level"] += 1
            game["max_hp"] += 4
            game["hp"] = game["max_hp"]
        enemy.update(_next_enemy(game["chapter"]))
        game["quest_title"] = f"Chapter {game['chapter']}: The Shifting Rift"
        game["quest_objective"] = "Stabilize the next breach before the realm fractures."
        summary = (
            f"Victory! The Ash Warden falls. You claim {reward} gold, "
            f"{coin_reward} coins, and {point_reward} points as the realm opens a new chapter."
        )
        game["last_narrative"] = summary
        return TurnResolution(updated, action, summary, victory=True)

    enemy_damage = random_source.randint(2, max(3, int(enemy["attack"])))
    if action == "guard":
        enemy_damage = max(0, enemy_damage - ward_strength)
    game["hp"] = max(0, game["hp"] - enemy_damage)
    if enemy_damage:
        summary = f"{summary} {enemy['name']} retaliates for {enemy_damage} damage."
    else:
        summary = f"{summary} Your ward absorbs the counterattack."
    game["last_narrative"] = summary
    return TurnResolution(updated, action, summary, victory=False)


def resolve_purchase(player: dict[str, Any], item_id: str) -> PurchaseResolution:
    """Buy a shop item, spending the hero's coins. Never mutate the input player."""
    item = SHOP_ITEMS.get(item_id)
    if item is None:
        return PurchaseResolution(
            player, item_id, "Unknown", "No such item exists.", False, reason="unknown_item"
        )
    updated = deepcopy(player)
    ensure_game_defaults(updated)
    game = updated["game"]
    if game["coins"] < item["cost"]:
        return PurchaseResolution(
            updated,
            item_id,
            item["name"],
            f"You need {item['cost']} coins, but you have {game['coins']}.",
            False,
            reason="insufficient_coins",
        )
    if item_id == "heal" and game["hp"] >= game["max_hp"]:
        return PurchaseResolution(
            updated,
            item_id,
            item["name"],
            "Your Vitality is already full; the potion would be wasted.",
            False,
            reason="already_full",
        )
    if item_id == "elixir" and game["energy"] >= game["max_energy"]:
        return PurchaseResolution(
            updated,
            item_id,
            item["name"],
            "Your Rift Energy is already full; the elixir would be wasted.",
            False,
            reason="already_full",
        )

    game["coins"] -= item["cost"]
    if item_id == "heal":
        restored = min(15, game["max_hp"] - game["hp"])
        game["hp"] = min(game["max_hp"], game["hp"] + 15)
        summary = f"You drink the Healing Draught and restore {restored} Vitality."
    elif item_id == "elixir":
        game["energy"] = min(game["max_energy"], game["energy"] + 3)
        summary = "The Rift Elixir surges through you, restoring 3 Energy."
    elif item_id == "blade":
        game["attack_bonus"] += 2
        game["inventory"].append("Rift Steel")
        summary = "The Rift Steel is forged into your blade. Strike damage +2 permanently."
    elif item_id == "ward":
        game["ward_bonus"] += 2
        game["inventory"].append("Aegis Sigil")
        summary = "The Aegis Sigil wards you. Ward strength +2 permanently."
    elif item_id == "charm":
        game["luck"] = True
        game["inventory"].append("Luck Charm")
        summary = "The Luck Charm hums. Scouting now grants +1 bonus insight."
    else:  # pragma: no cover - guarded above
        summary = "The item fades into the rift."
    if item["kind"] == "upgrade" and item_id not in game["purchased"]:
        game["purchased"].append(item_id)
    if item["kind"] == "consumable" and item["name"] not in game["inventory"]:
        game["inventory"].append(item["name"])
    updated["game"]["last_narrative"] = summary
    return PurchaseResolution(updated, item_id, item["name"], summary, success=True)


RULES = (
    "⚖️ ChronicleRift — Rules & Regulations\n\n"
    "1. Start your journey with /start or /play. Your hero is saved to the Chronicle "
    "and only you can change it.\n"
    "2. Pick one move per turn — Strike, Guard, Scout, or Rest. Each uses Rift Energy "
    "and alters the battle in a different way.\n"
    "3. Defeat the enemy to advance a chapter and earn Gold, Coins, and Points. "
    "Reaching 0 HP sends you back to camp, not to the beginning.\n"
    "4. Spend Coins in the Marketplace (/shop) on helpful items: potions, energy, and "
    "permanent upgrades.\n"
    "5. Progression accumulates XP toward your next Level. Each level raises your "
    "maximum Vitality.\n"
    "6. One hero per account. Progress is tied to your Telegram identity and is "
    "verified server-side — never trust client-reported scores.\n"
    "7. Be fair. Automation, spoofing, or abuse of the Chronicle results in loss of "
    "access. Have fun and keep the realm honourable.\n"
)


def _next_enemy(chapter: int) -> dict[str, Any]:
    scale = max(chapter - 1, 0)
    return {
        "name": "Rift Stalker" if chapter % 2 == 0 else "Obsidian Herald",
        "hp": DEFAULT_ENEMY["max_hp"] + scale * 5,
        "max_hp": DEFAULT_ENEMY["max_hp"] + scale * 5,
        "attack": DEFAULT_ENEMY["attack"] + scale,
        "art": "🜂" if chapter % 2 == 0 else "🗿",
    }
