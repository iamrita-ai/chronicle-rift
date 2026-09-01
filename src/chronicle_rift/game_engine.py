"""Deterministic-friendly, side-effect-free tactical turn resolver.

Combat model (documented so every player can understand it from /help):

- Strike costs 1 Rift Energy and deals ``d(4..8) + level + attack_bonus``.
  A perfect damage roll (8) is a CRITICAL hit worth 1.5x damage.
- Guard raises a ward worth ``d(2..5) + ward_bonus`` and refunds 1 Energy.
  A perfect ward roll (5) also reflects 2 damage back at the enemy.
- Scout grants ``d(1..3)`` XP (+1 with the Luck Charm), restores 1 Energy,
  and EXPOSES the enemy: your next Strike deals +2 damage.
- Rest heals ``d(4..7)`` HP and restores 2 Energy.
- Every 5th chapter is a boss (Ebon Colossus) with bonus HP/attack and
  double victory rewards. Falling to 0 HP never deletes progress: the hero
  retreats to camp, healed, on the next turn.
"""

from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass, field
from random import SystemRandom
from typing import Any, Protocol

from .models import DEFAULT_ENEMY, SHOP_ITEMS, ensure_game_defaults

VALID_ACTIONS = frozenset({"strike", "guard", "scout", "rest"})

STRIKE_MIN, STRIKE_MAX = 4, 8
CRIT_MULTIPLIER = 1.5
GUARD_MIN, GUARD_MAX = 2, 5
REFLECT_DAMAGE = 2
SCOUT_MIN, SCOUT_MAX = 1, 3
EXPOSED_BONUS = 2
REST_MIN, REST_MAX = 4, 7
BOSS_EVERY = 5
BOSS_HP_FACTOR = 1.6
BOSS_ATTACK_BONUS = 2
BOSS_REWARD_FACTOR = 2

# Flavor titles cycled as chapters advance so the quest line always reads fresh.
CHAPTER_TITLES = (
    "The Shifting Rift",
    "Embers Over the Vale",
    "The Whispering Breach",
    "Shards of the Fallen Gate",
    "The Obsidian Choir",
    "Storm Over the Riftlands",
)


class RandomSource(Protocol):
    def randint(self, start: int, stop: int) -> int: ...


@dataclass(frozen=True, slots=True)
class TurnResolution:
    player: dict[str, Any]
    action: str
    summary: str
    victory: bool
    # Structured, UI-facing turn telemetry (damage numbers, crits, healing…).
    effects: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class PurchaseResolution:
    player: dict[str, Any]
    item_id: str
    item_name: str
    summary: str
    success: bool
    reason: str | None = None


def _fresh_effects(action: str, enemy: dict[str, Any]) -> dict[str, Any]:
    return {
        "action": action,
        "crit": False,
        "damage": 0,
        "enemy_damage": 0,
        "healed": 0,
        "insight": 0,
        "ward": 0,
        "reflect": 0,
        "energy_delta": 0,
        "exposed_used": False,
        "leveled_up": False,
        "victory": False,
        "defeated": False,
        "revived": False,
        "boss": bool(enemy.get("boss", False)),
    }


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
    effects = _fresh_effects(action, enemy)

    if game["hp"] <= 0:
        game["hp"] = game["max_hp"]
        game["energy"] = max(1, game["max_energy"] // 2)
        effects["revived"] = True
        summary = "You return to the rift camp, wounds sealed, ready to fight again."
        game["last_narrative"] = summary
        return TurnResolution(updated, action, summary, victory=False, effects=effects)

    energy_before = game["energy"]
    ward_strength = 0
    if action == "strike":
        if game["energy"] <= 0:
            summary = (
                "Your blade is ready, but your Energy is spent. "
                "Guard, Scout, or Rest to recover it."
            )
            game["last_narrative"] = summary
            return TurnResolution(updated, action, summary, victory=False, effects=effects)
        game["energy"] -= 1
        roll = random_source.randint(STRIKE_MIN, STRIKE_MAX)
        damage = roll + game["level"] + game.get("attack_bonus", 0)
        if roll == STRIKE_MAX:
            damage = int(round(damage * CRIT_MULTIPLIER))
            effects["crit"] = True
        if game.get("exposed_strikes", 0) > 0:
            game["exposed_strikes"] -= 1
            damage += EXPOSED_BONUS
            effects["exposed_used"] = True
        enemy["hp"] = max(0, enemy["hp"] - damage)
        effects["damage"] = damage
        if effects["crit"]:
            summary = f"CRITICAL HIT! Your strike tears through the rift for {damage} damage."
        elif effects["exposed_used"]:
            summary = f"You exploit the enemy's exposure and strike for {damage} damage."
        else:
            summary = f"You strike for {damage} rift damage."
    elif action == "guard":
        ward_roll = random_source.randint(GUARD_MIN, GUARD_MAX)
        ward_strength = ward_roll + game.get("ward_bonus", 0)
        game["energy"] = min(game["max_energy"], game["energy"] + 1)
        effects["ward"] = ward_strength
        if ward_roll == GUARD_MAX:
            enemy["hp"] = max(0, enemy["hp"] - REFLECT_DAMAGE)
            effects["reflect"] = REFLECT_DAMAGE
            summary = (
                f"Perfect ward! You brace to absorb {ward_strength} damage "
                f"and reflect {REFLECT_DAMAGE} back."
            )
        else:
            summary = f"You raise a ward and prepare to absorb {ward_strength} damage."
    elif action == "scout":
        insight = random_source.randint(SCOUT_MIN, SCOUT_MAX)
        if game.get("luck"):
            insight += 1
        game["xp"] += insight
        game["energy"] = min(game["max_energy"], game["energy"] + 1)
        game["exposed_strikes"] = max(1, game.get("exposed_strikes", 0))
        effects["insight"] = insight
        summary = (
            f"You read the rift winds, gaining {insight} insight. "
            f"The enemy is exposed: your next Strike deals +{EXPOSED_BONUS} damage."
        )
    else:  # rest
        healing = random_source.randint(REST_MIN, REST_MAX)
        healed_actual = min(game["max_hp"] - game["hp"], healing)
        game["hp"] = min(game["max_hp"], game["hp"] + healing)
        game["energy"] = min(game["max_energy"], game["energy"] + 2)
        effects["healed"] = healed_actual
        summary = f"You rest beside the ember shrine and recover {healed_actual} HP."

    effects["energy_delta"] = game["energy"] - energy_before

    if enemy["hp"] <= 0:
        effects["victory"] = True
        fallen_name = enemy["name"]
        was_boss = bool(enemy.get("boss", False))
        multiplier = BOSS_REWARD_FACTOR if was_boss else 1
        reward = (10 + game["chapter"] * 3) * multiplier
        coin_reward = (8 + game["chapter"] * 2) * multiplier
        point_reward = (20 + game["chapter"] * 5) * multiplier
        game["gold"] += reward
        game["coins"] += coin_reward
        game["points"] += point_reward
        game["xp"] += 12
        game["chapter"] += 1
        game["exposed_strikes"] = 0
        effects.update(
            {
                "gold_gained": reward,
                "coins_gained": coin_reward,
                "points_gained": point_reward,
                "xp_gained": 12,
            }
        )
        if game["xp"] >= game["level"] * 20:
            game["level"] += 1
            game["max_hp"] += 4
            game["hp"] = game["max_hp"]
            effects["leveled_up"] = True
        enemy.update(_next_enemy(game["chapter"]))
        title = CHAPTER_TITLES[(game["chapter"] - 1) % len(CHAPTER_TITLES)]
        game["quest_title"] = f"Chapter {game['chapter']}: {title}"
        game["quest_objective"] = "Stabilize the next breach before the realm fractures."
        boss_note = " Boss bounties double the haul!" if was_boss else ""
        level_note = " You rise a level, vitality renewed!" if effects["leveled_up"] else ""
        summary = (
            f"Victory! The {fallen_name} falls. You claim {reward} gold, "
            f"{coin_reward} coins, and {point_reward} points as a new chapter opens."
            f"{boss_note}{level_note}"
        )
        game["last_narrative"] = summary
        return TurnResolution(updated, action, summary, victory=True, effects=effects)

    enemy_damage = random_source.randint(2, max(3, int(enemy.get("attack", 3))))
    if action == "guard":
        enemy_damage = max(0, enemy_damage - ward_strength)
    game["hp"] = max(0, game["hp"] - enemy_damage)
    effects["enemy_damage"] = enemy_damage
    if enemy_damage:
        summary = f"{summary} {enemy['name']} retaliates for {enemy_damage} damage."
    elif effects["reflect"]:
        summary = f"{summary} Your perfect ward absorbs the counterattack."
    else:
        summary = f"{summary} Your ward absorbs the counterattack."
    if game["hp"] == 0:
        effects["defeated"] = True
        summary = (
            f"{summary} Darkness takes you — but the Chronicle preserves all progress. "
            "Choose any move to wake at camp, fully healed."
        )
    game["last_narrative"] = summary
    return TurnResolution(updated, action, summary, victory=False, effects=effects)


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


HOW_TO_PLAY = (
    "📖 How to Play ChronicleRift\n\n"
    "ChronicleRift is a turn-based RPG inside Telegram. You face one enemy at a "
    "time and pick ONE move per turn. Bring the enemy's HP to 0 to clear the "
    "chapter and earn Gold, Coins, and Points.\n\n"
    "The four moves:\n"
    "⚔️ Strike — costs 1 Energy; deals 4–8 + Level + gear damage. A perfect roll "
    "is a CRITICAL hit worth 1.5x.\n"
    "🛡 Guard — blocks 2–5 of the counterattack and restores 1 Energy. A perfect "
    "ward also reflects 2 damage.\n"
    "🔮 Scout — +1–3 XP, +1 Energy, and EXPOSES the enemy so your next Strike "
    "hits +2 harder.\n"
    "🔥 Rest — recovers 4–7 HP and 2 Energy. Strikes need Energy, so weave these "
    "in.\n\n"
    "Death is safe: at 0 HP you wake at camp fully healed and keep everything.\n"
    "Every 5th chapter is a boss with double rewards.\n"
    "Spend Coins in /shop (potions, energy, permanent upgrades) and open /app "
    "for the visual battlefield.\n\n"
    "Commands: /play dashboard · /shop marketplace · /rules full rules · /app mini app"
)


RULES = (
    "⚖️ ChronicleRift — Rules & Regulations\n\n"
    "1. Start your journey with /start or /play. Your hero is saved to the Chronicle "
    "and only you can change it.\n"
    "2. Pick one move per turn — Strike, Guard, Scout, or Rest. Strikes use Rift "
    "Energy; the other moves restore it while shaping the battle differently.\n"
    "3. Defeat the enemy to advance a chapter and earn Gold, Coins, and Points. "
    "Every 5th chapter is a boss with double rewards.\n"
    "4. Reaching 0 HP sends you back to camp fully healed — progress is never lost.\n"
    "5. Spend Coins in the Marketplace (/shop) on helpful items: potions, energy, and "
    "permanent upgrades.\n"
    "6. Progression accumulates XP toward your next Level. Each level raises your "
    "maximum Vitality and your Strike damage.\n"
    "7. One hero per account. Progress is tied to your Telegram identity and is "
    "verified server-side — never trust client-reported scores.\n"
    "8. Be fair. Automation, spoofing, or abuse of the Chronicle results in loss of "
    "access. Have fun and keep the realm honourable.\n"
)


def _next_enemy(chapter: int) -> dict[str, Any]:
    scale = max(chapter - 1, 0)
    if chapter % BOSS_EVERY == 0:
        hp = int((DEFAULT_ENEMY["max_hp"] + scale * 5) * BOSS_HP_FACTOR)
        return {
            "name": "Ebon Colossus",
            "hp": hp,
            "max_hp": hp,
            "attack": DEFAULT_ENEMY["attack"] + scale + BOSS_ATTACK_BONUS,
            "art": "🌑",
            "boss": True,
        }
    return {
        "name": "Rift Stalker" if chapter % 2 == 0 else "Obsidian Herald",
        "hp": DEFAULT_ENEMY["max_hp"] + scale * 5,
        "max_hp": DEFAULT_ENEMY["max_hp"] + scale * 5,
        "attack": DEFAULT_ENEMY["attack"] + scale,
        "art": "🜂" if chapter % 2 == 0 else "🗿",
        "boss": False,
    }
