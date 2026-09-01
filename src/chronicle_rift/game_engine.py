"""Deterministic-friendly, side-effect-free tactical turn resolver."""

from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from random import SystemRandom
from typing import Any, Protocol

from .models import DEFAULT_ENEMY

VALID_ACTIONS = frozenset({"strike", "guard", "scout", "rest"})


class RandomSource(Protocol):
    def randint(self, start: int, stop: int) -> int: ...


@dataclass(frozen=True, slots=True)
class TurnResolution:
    player: dict[str, Any]
    action: str
    summary: str
    victory: bool


def resolve_turn(
    player: dict[str, Any], action: str, rng: RandomSource | None = None
) -> TurnResolution:
    """Resolve one action and return a new player document, never mutate input."""
    if action not in VALID_ACTIONS:
        raise ValueError("Unknown game action.")

    random_source = rng or SystemRandom()
    updated = deepcopy(player)
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
        damage = random_source.randint(4, 8) + game["level"]
        enemy["hp"] = max(0, enemy["hp"] - damage)
        summary = f"You strike for {damage} rift damage."
    elif action == "guard":
        ward_strength = random_source.randint(2, 5)
        game["energy"] = min(game["max_energy"], game["energy"] + 1)
        summary = f"You raise a ward and prepare to absorb {ward_strength} damage."
    elif action == "scout":
        insight = random_source.randint(1, 3)
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
        game["gold"] += reward
        game["xp"] += 12
        game["chapter"] += 1
        if game["xp"] >= game["level"] * 20:
            game["level"] += 1
            game["max_hp"] += 4
            game["hp"] = game["max_hp"]
        enemy.update(_next_enemy(game["chapter"]))
        game["quest_title"] = f"Chapter {game['chapter']}: The Shifting Rift"
        game["quest_objective"] = "Stabilize the next breach before the realm fractures."
        summary = f"Victory! The Ash Warden falls. You claim {reward} gold and open a new chapter."
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


def _next_enemy(chapter: int) -> dict[str, Any]:
    scale = max(chapter - 1, 0)
    return {
        "name": "Rift Stalker" if chapter % 2 == 0 else "Obsidian Herald",
        "hp": DEFAULT_ENEMY["max_hp"] + scale * 5,
        "max_hp": DEFAULT_ENEMY["max_hp"] + scale * 5,
        "attack": DEFAULT_ENEMY["attack"] + scale,
        "art": "🜂" if chapter % 2 == 0 else "🗿",
    }
