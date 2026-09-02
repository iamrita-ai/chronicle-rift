"""Deterministic-friendly, side-effect-free tactical turn resolver.

COMBAT MODEL (v2 — everything below is also shown to the player in-game):

The loop is: *the enemy always tells you what it will do next*, then you pick ONE
of four moves, then the enemy does exactly the move it telegraphed.

Your moves
- Strike  — costs 1 Energy. Damage = d(4..8) + Level + gear + Focus bonus.
            A top roll (8) is a CRITICAL (x1.5) and sets the enemy BURNING.
- Guard   — free, +1 Energy, +1 Focus. Builds a ward of d(2..5) + gear that is
            subtracted from the enemy's telegraphed hit. A top roll (5) is a
            PERFECT WARD: it also reflects 2 damage.
- Scout   — free, +1 Energy, +1 Focus, +d(1..3) XP, and EXPOSES the enemy so
            your next Strike deals +2.
- Rest    — free, +2 Energy, +1 Focus, heals d(4..7) HP.

Focus (the combo meter)
- Guard / Scout / Rest each add 1 Focus (max 3). Strike spends ALL Focus for
  +2 damage per point. So "set up, then swing" always beats mashing Strike.

Burn
- A critical hit sets BURN for 2 turns; the enemy loses 3 HP at the start of
  each of your following turns. Burn cannot kill mid-setup — it can, and that
  counts as a victory.

Enemy intent (telegraph)
- Every enemy follows a fixed, learnable pattern of moves, and the NEXT one is
  always visible: Slash (normal), Heavy Blow (big — Guard it), Rift Drain
  (steals 1 Energy) or Mend (it heals itself — punish it now). Bosses also use
  Quake. Because intent is deterministic, Guard is a real decision, not a coin
  flip.

Safety net
- Falling to 0 HP never deletes progress: the hero retreats to camp, fully
  healed, on the next turn.
- Every 5th chapter is a boss (Ebon Colossus) with bonus HP/attack and double
  victory rewards.
"""

from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass, field
from random import SystemRandom
from typing import Any, Protocol

from .models import (
    CHARACTERS,
    DEFAULT_ENEMY,
    ELEMENTS,
    ITEMS,
    LOOT_TABLE,
    MAX_RELIC_LEVEL,
    MONSTERS,
    add_item,
    apply_relic_bonuses,
    character_of,
    ensure_game_defaults,
    monster_for_chapter,
    relic_cost,
    remove_item,
)

ATTACK_ACTIONS = frozenset({"strike", "heavy", "special"})
VALID_ACTIONS = frozenset({"strike", "heavy", "special", "guard", "scout", "rest"})

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

MAX_FOCUS = 3
FOCUS_DAMAGE = 2
BURN_TURNS = 2
BURN_DAMAGE = 3

# Flavor titles cycled as chapters advance so the quest line always reads fresh.
CHAPTER_TITLES = (
    "The Shifting Rift",
    "Embers Over the Vale",
    "The Whispering Breach",
    "Shards of the Fallen Gate",
    "The Obsidian Choir",
    "Storm Over the Riftlands",
)

# Enemy intents. Each is telegraphed one turn ahead so Guard/Strike become real
# decisions instead of guesses. ``bonus`` is added to the enemy's attack value.
INTENTS: dict[str, dict[str, Any]] = {
    "slash": {
        "name": "Slash",
        "kind": "attack",
        "bonus": 0,
        "advice": "A normal hit — Guard trims it, or race it down with Strike.",
    },
    "heavy": {
        "name": "Heavy Blow",
        "kind": "attack",
        "bonus": 4,
        "advice": "Big incoming hit — Guard is usually the right answer.",
    },
    "drain": {
        "name": "Rift Drain",
        "kind": "drain",
        "bonus": -2,
        "advice": "Steals 1 Rift Energy — Rest or Guard keeps your Strikes online.",
    },
    "mend": {
        "name": "Mend",
        "kind": "heal",
        "bonus": 0,
        "advice": "It will heal itself — Strike NOW to waste the attempt.",
    },
    "quake": {
        "name": "Rift Quake",
        "kind": "attack",
        "bonus": 6,
        "advice": "Boss slam — Guard, or you will lose a huge chunk of Vitality.",
    },
}

MEND_HEAL = 5
DRAIN_ENERGY = 1

# Fixed, learnable attack rotations per enemy.
ENEMY_PATTERNS: dict[str, tuple[str, ...]] = {
    "Ash Warden": ("slash", "slash", "heavy"),
    "Obsidian Herald": ("slash", "drain", "heavy"),
    "Rift Stalker": ("slash", "heavy", "mend"),
    "Ebon Colossus": ("slash", "heavy", "drain", "quake"),
}
DEFAULT_PATTERN = ("slash", "slash", "heavy")


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


REGEN_HEAL = 5

# Loot: how many items drop and how likely each rarity tier is. Bosses roll on
# a much richer table, which is the main reason to hunt them.
LOOT_ROLLS = 2
BOSS_LOOT_ROLLS = 4


@dataclass(frozen=True, slots=True)
class PurchaseResolution:
    player: dict[str, Any]
    item_id: str
    item_name: str
    summary: str
    success: bool
    reason: str | None = None


# --------------------------------------------------------------------------- #
# Enemy intent helpers
# --------------------------------------------------------------------------- #
def enemy_pattern(enemy: dict[str, Any]) -> tuple[str, ...]:
    monster = MONSTERS.get(str(enemy.get("id", "")))
    if monster:
        return tuple(monster["pattern"])
    return ENEMY_PATTERNS.get(str(enemy.get("name")), DEFAULT_PATTERN)


def intent_payload(enemy: dict[str, Any]) -> dict[str, Any]:
    """Describe the move this enemy will perform on its NEXT turn."""
    pattern = enemy_pattern(enemy)
    index = int(enemy.get("intent_index", 0)) % len(pattern)
    intent_id = pattern[index]
    spec = INTENTS[intent_id]
    attack = int(enemy.get("attack", DEFAULT_ENEMY["attack"]))
    damage = 0
    if spec["kind"] in {"attack", "drain"}:
        damage = max(1, attack + int(spec["bonus"]))
    return {
        "id": intent_id,
        "name": spec["name"],
        "kind": spec["kind"],
        "damage": damage,
        "heal": MEND_HEAL if spec["kind"] == "heal" else 0,
        "advice": spec["advice"],
    }


def sync_intent(enemy: dict[str, Any]) -> dict[str, Any]:
    """Store (and return) the enemy's telegraphed next move on the document."""
    enemy.setdefault("intent_index", 0)
    intent = intent_payload(enemy)
    enemy["intent"] = intent
    return intent


def _advance_intent(enemy: dict[str, Any]) -> None:
    pattern = enemy_pattern(enemy)
    enemy["intent_index"] = (int(enemy.get("intent_index", 0)) + 1) % len(pattern)
    sync_intent(enemy)


def _fresh_effects(action: str, enemy: dict[str, Any]) -> dict[str, Any]:
    return {
        "action": action,
        "crit": False,
        "damage": 0,
        "enemy_damage": 0,
        "blocked": 0,
        "healed": 0,
        "insight": 0,
        "ward": 0,
        "reflect": 0,
        "burn_damage": 0,
        "regen_healed": 0,
        "stunned": False,
        "loot": [],
        "burn_applied": 0,
        "focus_spent": 0,
        "focus_gained": 0,
        "energy_delta": 0,
        "energy_drained": 0,
        "enemy_healed": 0,
        "enemy_intent": None,
        "exposed_used": False,
        "leveled_up": False,
        "victory": False,
        "defeated": False,
        "revived": False,
        "boss": bool(enemy.get("boss", False)),
    }


def _victory(
    updated: dict[str, Any],
    action: str,
    effects: dict[str, Any],
    fallen_name: str,
    was_boss: bool,
    rng: RandomSource | None = None,
) -> TurnResolution:
    """Award rewards, roll the next chapter, and build the victory summary."""
    game = updated["game"]
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
    game["focus"] = 0
    game["burn"] = 0
    effects["victory"] = True
    effects.update(
        {
            "gold_gained": reward,
            "coins_gained": coin_reward,
            "points_gained": point_reward,
            "xp_gained": 12,
        }
    )
    # Reward chest: several random items every time a chapter is cleared.
    drops = roll_loot(game["chapter"] - 1, was_boss, rng or SystemRandom())
    loot_cards = []
    for drop in drops:
        add_item(game, drop, 1)
        loot_cards.append(
            {
                "id": drop,
                "name": ITEMS[drop]["name"],
                "art": ITEMS[drop].get("art", ""),
                "rarity": ITEMS[drop]["rarity"],
                "emoji": ITEMS[drop]["emoji"],
                "ability": ITEMS[drop]["ability"],
            }
        )
    effects["loot"] = loot_cards

    if game["xp"] >= game["level"] * 20:
        game["level"] += 1
        game["base_max_hp"] = int(game.get("base_max_hp", game["max_hp"])) + 4
        apply_relic_bonuses(game)
        game["hp"] = game["max_hp"]
        effects["leveled_up"] = True
    game["enemy"] = _next_enemy(game["chapter"])
    sync_intent(game["enemy"])
    effects["enemy_intent"] = game["enemy"]["intent"]
    title = CHAPTER_TITLES[(game["chapter"] - 1) % len(CHAPTER_TITLES)]
    game["quest_title"] = f"Chapter {game['chapter']}: {title}"
    game["quest_objective"] = (
        f"Defeat the {game['enemy']['name']} to open Chapter {game['chapter'] + 1}."
    )
    loot_note = ""
    if loot_cards:
        names = ", ".join(f"{card['emoji']} {card['name']}" for card in loot_cards)
        loot_note = f" The reward chest holds: {names}."
    boss_note = " Boss bounties double the haul!" if was_boss else ""
    level_note = " You rise a level, vitality renewed!" if effects["leveled_up"] else ""
    summary = (
        f"Victory! The {fallen_name} falls. You claim {reward} gold, "
        f"{coin_reward} coins, and {point_reward} points as a new chapter opens."
        f"{loot_note}{boss_note}{level_note}"
    )
    game["last_narrative"] = summary
    return TurnResolution(updated, action, summary, victory=True, effects=effects)


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
    sync_intent(enemy)
    effects = _fresh_effects(action, enemy)

    # --- safety net: waking up at camp costs the turn but nothing else -------
    if game["hp"] <= 0:
        game["hp"] = game["max_hp"]
        game["energy"] = max(1, game["max_energy"] // 2)
        game["focus"] = 0
        effects["revived"] = True
        effects["enemy_intent"] = enemy["intent"]
        summary = "You return to the rift camp, wounds sealed, ready to fight again."
        game["last_narrative"] = summary
        return TurnResolution(updated, action, summary, victory=False, effects=effects)

    game["turn"] = int(game.get("turn", 0)) + 1
    energy_before = game["energy"]
    focus_before = int(game.get("focus", 0))
    ward_strength = 0
    lines: list[str] = []

    # --- regeneration and burn tick before you act --------------------------
    if int(game.get("regen", 0)) > 0:
        game["regen"] = int(game["regen"]) - 1
        healed = min(game["max_hp"] - game["hp"], REGEN_HEAL)
        game["hp"] += healed
        effects["regen_healed"] = healed
        if healed:
            lines.append(f"The Emberweave Balm knits {healed} Vitality back together.")

    # --- burn ticks before you act ------------------------------------------
    if int(game.get("burn", 0)) > 0:
        game["burn"] = int(game["burn"]) - 1
        enemy["hp"] = max(0, enemy["hp"] - BURN_DAMAGE)
        effects["burn_damage"] = BURN_DAMAGE
        lines.append(f"Rift-fire burns the {enemy['name']} for {BURN_DAMAGE}.")
        if enemy["hp"] <= 0:
            return _victory(
                updated, action, effects, enemy["name"], bool(enemy.get("boss")), random_source
            )

    # --- your move -----------------------------------------------------------
    if action in ATTACK_ACTIONS:
        character = character_of(game)
        spec = character["attacks"][action]
        element = character["element"]
        cost = int(spec["cost"])
        if game["energy"] < cost:
            summary = (
                f"{spec['name']} needs {cost} Rift Energy and you have {game['energy']}. "
                "Guard, Scout or Rest to recover it (they are all free)."
            )
            game["last_narrative"] = summary
            effects["enemy_intent"] = enemy["intent"]
            effects["blocked_action"] = True
            return TurnResolution(updated, action, summary, victory=False, effects=effects)

        game["energy"] -= cost
        roll = random_source.randint(int(spec["min"]), int(spec["max"]))
        damage = roll + game["level"] + game.get("attack_bonus", 0) + int(game.get("power", 0))
        if roll == int(spec["max"]):
            damage = int(round(damage * CRIT_MULTIPLIER))
            effects["crit"] = True
            if action != "special":
                game["burn"] = BURN_TURNS
                effects["burn_applied"] = BURN_TURNS
        if game.get("exposed_strikes", 0) > 0:
            game["exposed_strikes"] -= 1
            damage += EXPOSED_BONUS
            effects["exposed_used"] = True
        if focus_before > 0:
            damage += focus_before * FOCUS_DAMAGE
            effects["focus_spent"] = focus_before
            game["focus"] = 0

        effects["attack_name"] = spec["name"]
        effects["element"] = element
        extra_lines: list[str] = []

        if action == "special":
            effects["special"] = element
            if element == "fire":
                game["burn"] = 3
                effects["burn_applied"] = 3
                extra_lines.append("Cinder clings to it: BURNING for 3 turns.")
            elif element == "ice":
                game["stun"] = int(game.get("stun", 0)) + 1
                effects["stun"] = game["stun"]
                extra_lines.append("It is FROZEN and will miss its next move.")
            elif element == "wind":
                second = max(1, damage // 2)
                damage += second
                game["energy"] = min(game["max_energy"], game["energy"] + 2)
                effects["second_hit"] = second
                extra_lines.append(
                    f"The gale strikes a second time for {second} and returns 2 Energy."
                )
            elif element == "arcane":
                effects["pierce"] = True
                drain = max(1, damage // 2)
                healed = min(game["max_hp"] - game["hp"], drain)
                game["hp"] += healed
                effects["healed"] = healed
                extra_lines.append(f"The siphon pierces every ward and returns {healed} Vitality.")
            elif element == "shadow":
                drain = max(1, int(damage * 0.4))
                healed = min(game["max_hp"] - game["hp"], drain)
                game["hp"] += healed
                game["focus"] = min(MAX_FOCUS, int(game.get("focus", 0)) + 2)
                effects["healed"] = healed
                extra_lines.append(
                    f"You harvest {healed} Vitality and surge to {game['focus']} Focus."
                )

        enemy["hp"] = max(0, enemy["hp"] - damage)
        effects["damage"] = damage
        if effects["crit"]:
            lines.append(f"CRITICAL {spec['name']}! {damage} damage tears through.")
        elif effects["focus_spent"]:
            lines.append(
                f"{spec['name']} spends {effects['focus_spent']} Focus for {damage} damage."
            )
        else:
            lines.append(f"{spec['name']} lands for {damage} damage.")
        lines.extend(extra_lines)
    elif action == "guard":
        ward_roll = random_source.randint(GUARD_MIN, GUARD_MAX)
        ward_strength = ward_roll + game.get("ward_bonus", 0)
        game["energy"] = min(game["max_energy"], game["energy"] + 1)
        effects["ward"] = ward_strength
        if ward_roll == GUARD_MAX:
            enemy["hp"] = max(0, enemy["hp"] - REFLECT_DAMAGE)
            effects["reflect"] = REFLECT_DAMAGE
            lines.append(
                f"Perfect ward! You brace against {ward_strength} damage "
                f"and reflect {REFLECT_DAMAGE} back."
            )
        else:
            lines.append(f"You raise a ward against {ward_strength} damage.")
    elif action == "scout":
        insight = random_source.randint(SCOUT_MIN, SCOUT_MAX)
        if game.get("luck"):
            insight += 1
        game["xp"] += insight
        game["energy"] = min(game["max_energy"], game["energy"] + 1)
        game["exposed_strikes"] = max(1, game.get("exposed_strikes", 0))
        effects["insight"] = insight
        lines.append(
            f"You read the rift winds for {insight} XP. The enemy is EXPOSED: "
            f"your next Strike deals +{EXPOSED_BONUS}."
        )
    else:  # rest
        healing = random_source.randint(REST_MIN, REST_MAX)
        healed_actual = min(game["max_hp"] - game["hp"], healing)
        game["hp"] = min(game["max_hp"], game["hp"] + healing)
        game["energy"] = min(game["max_energy"], game["energy"] + 2)
        effects["healed"] = healed_actual
        lines.append(f"You rest beside the ember shrine and recover {healed_actual} HP.")

    # Setup moves build Focus; Strike is the payoff.
    if action != "strike":
        gained = min(MAX_FOCUS, focus_before + 1) - focus_before
        game["focus"] = min(MAX_FOCUS, focus_before + 1)
        effects["focus_gained"] = gained
        if gained:
            lines.append(f"Focus {game['focus']}/{MAX_FOCUS} — your next Strike hits harder.")

    effects["energy_delta"] = game["energy"] - energy_before

    if enemy["hp"] <= 0:
        was_boss = bool(enemy.get("boss", False))
        fallen = enemy["name"]
        resolution = _victory(updated, action, effects, fallen, was_boss, random_source)
        return TurnResolution(
            resolution.player,
            action,
            " ".join([*lines, resolution.summary]),
            victory=True,
            effects=resolution.effects,
        )

    # --- the enemy performs exactly the move it telegraphed ------------------
    intent = enemy["intent"]
    if int(game.get("stun", 0)) > 0:
        game["stun"] = int(game["stun"]) - 1
        effects["stunned"] = True
        lines.append(f"Blinded by Veil Powder, {enemy['name']} swings at empty air.")
    elif intent["kind"] == "heal":
        before = enemy["hp"]
        enemy["hp"] = min(enemy["max_hp"], enemy["hp"] + intent["heal"])
        effects["enemy_healed"] = enemy["hp"] - before
        if effects["enemy_healed"]:
            lines.append(f"{enemy['name']} mends itself for {effects['enemy_healed']}.")
        else:
            lines.append(f"{enemy['name']} tries to mend, but it is already whole.")
    else:
        raw = int(intent["damage"])
        dealt = max(0, raw - ward_strength)
        effects["blocked"] = raw - dealt
        game["hp"] = max(0, game["hp"] - dealt)
        effects["enemy_damage"] = dealt
        if intent["kind"] == "drain" and dealt > 0 and game["energy"] > 0:
            game["energy"] = max(0, game["energy"] - DRAIN_ENERGY)
            effects["energy_drained"] = DRAIN_ENERGY
        label = intent["name"]
        if dealt and effects["blocked"]:
            lines.append(
                f"{enemy['name']} answers with {label}: {dealt} damage "
                f"({effects['blocked']} blocked by your ward)."
            )
        elif dealt:
            lines.append(f"{enemy['name']} answers with {label} for {dealt} damage.")
        else:
            lines.append(f"Your ward swallows {enemy['name']}'s {label} completely.")
        if effects["energy_drained"]:
            lines.append("It siphons 1 Rift Energy.")

    effects["energy_delta"] = game["energy"] - energy_before

    _advance_intent(enemy)
    effects["enemy_intent"] = enemy["intent"]
    next_intent = enemy["intent"]
    if next_intent["kind"] == "heal":
        lines.append(f"Next: it will {next_intent['name']} for {next_intent['heal']} — punish it.")
    else:
        lines.append(f"Next: {next_intent['name']} for {next_intent['damage']} damage.")

    if game["hp"] == 0:
        effects["defeated"] = True
        lines.append(
            "Darkness takes you — but the Chronicle preserves all progress. "
            "Choose any move to wake at camp, fully healed."
        )

    summary = " ".join(lines)
    game["last_narrative"] = summary
    return TurnResolution(updated, action, summary, victory=False, effects=effects)


@dataclass(frozen=True, slots=True)
class ItemResolution:
    """Result of any satchel/forge operation (use, sell, buy, upgrade)."""

    player: dict[str, Any]
    item_id: str
    item_name: str
    summary: str
    success: bool
    reason: str | None = None
    effects: dict[str, Any] = field(default_factory=dict)


def resolve_purchase(player: dict[str, Any], item_id: str) -> PurchaseResolution:
    """Buy an item. Consumables go into the satchel; relics are forged at level 1."""
    item = ITEMS.get(item_id)
    if item is None or not item.get("cost"):
        return PurchaseResolution(
            player, item_id, "Unknown", "That item is not for sale.", False, reason="unknown_item"
        )
    updated = deepcopy(player)
    ensure_game_defaults(updated)
    game = updated["game"]
    relics = game["relics"]

    if item["kind"] == "relic":
        level = int(relics.get(item_id, 0))
        if level >= MAX_RELIC_LEVEL:
            return PurchaseResolution(
                updated,
                item_id,
                item["name"],
                f"{item['name']} is already mastered at level {MAX_RELIC_LEVEL}.",
                False,
                reason="max_level",
            )
        price = relic_cost(item_id, level)
        if game["coins"] < price:
            return PurchaseResolution(
                updated,
                item_id,
                item["name"],
                f"You need {price} coins, but you have {game['coins']}.",
                False,
                reason="insufficient_coins",
            )
        game["coins"] -= price
        relics[item_id] = level + 1
        apply_relic_bonuses(game)
        verb = "forge" if level == 0 else "reforge"
        summary = f"You {verb} the {item['name']} to level {relics[item_id]}. {item['ability']}."
        game["last_narrative"] = summary
        return PurchaseResolution(updated, item_id, item["name"], summary, success=True)

    price = int(item["cost"])
    if game["coins"] < price:
        return PurchaseResolution(
            updated,
            item_id,
            item["name"],
            f"You need {price} coins, but you have {game['coins']}.",
            False,
            reason="insufficient_coins",
        )
    game["coins"] -= price
    add_item(game, item_id, 1)
    summary = f"You buy {item['name']} ({item['ability']}). It is in your satchel."
    game["last_narrative"] = summary
    return PurchaseResolution(updated, item_id, item["name"], summary, success=True)


def upgrade_relic(player: dict[str, Any], item_id: str) -> ItemResolution:
    """Spend coins to raise an owned relic by one level."""
    item = ITEMS.get(item_id)
    if item is None or item["kind"] != "relic":
        return ItemResolution(
            player, item_id, "Unknown", "That is not a relic.", False, reason="unknown_item"
        )
    updated = deepcopy(player)
    ensure_game_defaults(updated)
    game = updated["game"]
    level = int(game["relics"].get(item_id, 0))
    if level <= 0:
        return ItemResolution(
            updated,
            item_id,
            item["name"],
            f"You do not own the {item['name']} yet — buy it in the Marketplace first.",
            False,
            reason="not_owned",
        )
    if level >= MAX_RELIC_LEVEL:
        return ItemResolution(
            updated,
            item_id,
            item["name"],
            f"{item['name']} is already mastered at level {MAX_RELIC_LEVEL}.",
            False,
            reason="max_level",
        )
    price = relic_cost(item_id, level)
    if game["coins"] < price:
        return ItemResolution(
            updated,
            item_id,
            item["name"],
            f"Upgrading costs {price} coins, but you have {game['coins']}.",
            False,
            reason="insufficient_coins",
        )
    game["coins"] -= price
    game["relics"][item_id] = level + 1
    apply_relic_bonuses(game)
    summary = f"The {item['name']} is reforged to level {level + 1}. {item['ability']}."
    game["last_narrative"] = summary
    return ItemResolution(
        updated,
        item_id,
        item["name"],
        summary,
        True,
        effects={"upgraded": True, "level": level + 1},
    )


def sell_item(player: dict[str, Any], item_id: str, quantity: int = 1) -> ItemResolution:
    """Turn satchel items into coins."""
    item = ITEMS.get(item_id)
    if item is None or item["kind"] == "relic":
        return ItemResolution(
            player, item_id, "Unknown", "That item cannot be sold.", False, reason="unknown_item"
        )
    quantity = max(1, int(quantity))
    updated = deepcopy(player)
    ensure_game_defaults(updated)
    game = updated["game"]
    if not remove_item(game, item_id, quantity):
        return ItemResolution(
            updated,
            item_id,
            item["name"],
            f"You do not have {quantity} x {item['name']} to sell.",
            False,
            reason="not_held",
        )
    payout = int(item["sell"]) * quantity
    game["coins"] += payout
    summary = f"Sold {quantity} x {item['name']} for {payout} coins."
    game["last_narrative"] = summary
    return ItemResolution(
        updated, item_id, item["name"], summary, True, effects={"coins_gained": payout}
    )


def use_item(player: dict[str, Any], item_id: str) -> ItemResolution:
    """Consume an item from the satchel. Using an item does not cost your turn."""
    item = ITEMS.get(item_id)
    if item is None:
        return ItemResolution(
            player, item_id, "Unknown", "No such item exists.", False, reason="unknown_item"
        )
    if item["kind"] != "consumable":
        return ItemResolution(
            player, item_id, item["name"], "That item cannot be used.", False, reason="not_usable"
        )
    updated = deepcopy(player)
    ensure_game_defaults(updated)
    game = updated["game"]
    if int((game.get("inventory") or {}).get(item_id, 0)) <= 0:
        return ItemResolution(
            updated,
            item_id,
            item["name"],
            f"You have no {item['name']} left.",
            False,
            reason="not_held",
        )

    effect = item.get("effect", {})
    enemy = game["enemy"]
    sync_intent(enemy)
    effects: dict[str, Any] = {"item": item_id, "action": "item"}
    parts: list[str] = []

    if "heal" in effect and game["hp"] >= game["max_hp"] and "energy" not in effect:
        return ItemResolution(
            updated,
            item_id,
            item["name"],
            "Your Vitality is already full — save it for later.",
            False,
            reason="already_full",
        )
    if "energy" in effect and "heal" not in effect and game["energy"] >= game["max_energy"]:
        return ItemResolution(
            updated,
            item_id,
            item["name"],
            "Your Rift Energy is already full — save it for later.",
            False,
            reason="already_full",
        )

    remove_item(game, item_id, 1)

    if "heal" in effect:
        healed = min(game["max_hp"] - game["hp"], int(effect["heal"]))
        game["hp"] += healed
        effects["healed"] = healed
        parts.append(f"restores {healed} Vitality")
    if "energy" in effect:
        before = game["energy"]
        game["energy"] = min(game["max_energy"], game["energy"] + int(effect["energy"]))
        effects["energy_delta"] = game["energy"] - before
        parts.append(f"restores {game['energy'] - before} Rift Energy")
    if "regen" in effect:
        game["regen"] = int(game.get("regen", 0)) + int(effect["regen"])
        effects["regen"] = game["regen"]
        parts.append(f"grants regeneration for {game['regen']} turns")
    if "focus" in effect:
        game["focus"] = min(MAX_FOCUS, int(effect["focus"]))
        effects["focus"] = game["focus"]
        parts.append(f"fills Focus to {game['focus']}/{MAX_FOCUS}")
    if "stun" in effect:
        game["stun"] = int(game.get("stun", 0)) + int(effect["stun"])
        effects["stun"] = game["stun"]
        parts.append("blinds the enemy for its next move")
    if "damage" in effect:
        damage = int(effect["damage"])
        enemy["hp"] = max(0, enemy["hp"] - damage)
        effects["damage"] = damage
        parts.append(f"detonates for {damage} damage")

    summary = f"{item['name']} {' and '.join(parts) if parts else 'is used'}."

    if enemy["hp"] <= 0:
        resolution = _victory(
            updated, "item", _fresh_effects("item", enemy), enemy["name"], bool(enemy.get("boss"))
        )
        merged = {**effects, **resolution.effects}
        combined = f"{summary} {resolution.summary}"
        resolution.player["game"]["last_narrative"] = combined
        return ItemResolution(
            resolution.player, item_id, item["name"], combined, True, effects=merged
        )

    game["last_narrative"] = summary
    return ItemResolution(updated, item_id, item["name"], summary, True, effects=effects)


def buy_character(player: dict[str, Any], character_id: str) -> ItemResolution:
    """Purchase a playable character with coins."""
    character = CHARACTERS.get(character_id)
    if character is None:
        return ItemResolution(
            player, character_id, "Unknown", "No such hero exists.", False, reason="unknown_item"
        )
    updated = deepcopy(player)
    ensure_game_defaults(updated)
    game = updated["game"]
    if character_id in game["owned_characters"]:
        return ItemResolution(
            updated,
            character_id,
            character["name"],
            f"You already command {character['name']}.",
            False,
            reason="already_owned",
        )
    price = int(character["cost"])
    if game["coins"] < price:
        return ItemResolution(
            updated,
            character_id,
            character["name"],
            f"{character['name']} costs {price} coins, but you have {game['coins']}.",
            False,
            reason="insufficient_coins",
        )
    game["coins"] -= price
    game["owned_characters"].append(character_id)
    game["character"] = character_id
    apply_relic_bonuses(game)
    game["hp"] = game["max_hp"]
    game["energy"] = game["max_energy"]
    element = ELEMENTS[character["element"]]["name"]
    summary = f"{character['name']} joins your Chronicle. Element: {element}."
    game["last_narrative"] = summary
    return ItemResolution(
        updated, character_id, character["name"], summary, True, effects={"character": character_id}
    )


def select_character(player: dict[str, Any], character_id: str) -> ItemResolution:
    """Switch to an owned character; stats are rebuilt from that hero."""
    character = CHARACTERS.get(character_id)
    if character is None:
        return ItemResolution(
            player, character_id, "Unknown", "No such hero exists.", False, reason="unknown_item"
        )
    updated = deepcopy(player)
    ensure_game_defaults(updated)
    game = updated["game"]
    if character_id not in game["owned_characters"]:
        return ItemResolution(
            updated,
            character_id,
            character["name"],
            f"You do not own {character['name']} yet.",
            False,
            reason="not_owned",
        )
    game["character"] = character_id
    apply_relic_bonuses(game)
    summary = f"{character['name']} steps into the arena."
    game["last_narrative"] = summary
    return ItemResolution(
        updated, character_id, character["name"], summary, True, effects={"character": character_id}
    )


def roll_loot(chapter: int, boss: bool, rng: RandomSource) -> list[str]:
    """Roll the reward chest for a cleared chapter."""
    rolls = BOSS_LOOT_ROLLS if boss else LOOT_ROLLS
    if chapter >= 4:
        rolls += 1
    drops: list[str] = []
    for _ in range(rolls):
        score = rng.randint(1, 100) + (chapter * 2) + (25 if boss else 0)
        if score >= 96:
            tier = "legendary"
        elif score >= 82:
            tier = "epic"
        elif score >= 55:
            tier = "rare"
        else:
            tier = "common"
        pool = LOOT_TABLE[tier]
        drops.append(pool[rng.randint(0, len(pool) - 1)])
    return drops


HOW_TO_PLAY = (
    "📖 HOW TO PLAY — ChronicleRift in 60 seconds\n\n"
    "WHAT IS THIS GAME?\n"
    "A turn-based fantasy RPG that lives inside Telegram. You are a Riftwalker. "
    "One monster blocks each chapter. Empty its HP bar and you clear the chapter, "
    "collect Gold, Coins and Points, and a stronger monster appears.\n\n"
    "THE ONE RULE\n"
    "Each turn you tap ONE button. Then the enemy does exactly the move "
    "it warned you about (look for the ‘Next:’ line). That is the whole game.\n\n"
    "YOUR SIX MOVES\n"
    "⚔️ Strike — 1 Energy. Your quick attack; a perfect roll is a CRITICAL (x1.5).\n"
    "💥 Heavy — 2 Energy. Slower, much bigger damage.\n"
    "✨ Special — 3 Energy. Your hero's elemental move: burn, freeze, double-hit, "
    "pierce or lifesteal, depending on which hero you play.\n"
    "🛡 Guard — free. Blocks 2–5 of the incoming hit, +1 Energy, +1 Focus. "
    "Use it on the turn the enemy telegraphs Heavy Blow or Rift Quake.\n"
    "🔮 Scout — free. +1–3 XP, +1 Energy, +1 Focus, and EXPOSES the enemy "
    "(next Strike +2).\n"
    "🔥 Rest — free. Heals 4–7 HP, +2 Energy, +1 Focus.\n\n"
    "FOCUS = YOUR COMBO METER\n"
    "Guard, Scout and Rest each give +1 Focus (max 3). Strike spends all of it "
    "for +2 damage per point. Set up two turns, then swing — that is the combo.\n\n"
    "READ THE ENEMY\n"
    "Slash = normal hit · Heavy Blow = big hit, Guard it · Rift Drain = steals "
    "1 Energy · Mend = it heals itself, so Strike immediately · Rift Quake = "
    "boss slam, Guard it.\n\n"
    "YOU CANNOT LOSE PROGRESS\n"
    "At 0 HP you simply wake at camp fully healed, keeping every coin and level.\n\n"
    "LOOT, SATCHEL AND THE FORGE\n"
    "Every cleared chapter drops random items into your satchel — potions, "
    "bombs, veil powder and treasure. Open the Rift Arena Mini App to USE "
    "potions mid-fight, SELL treasure for coins, and UPGRADE relics up to "
    "level 5 in the Forge. /bag shows what you are carrying.\n\n"
    "SPEND YOUR COINS\n"
    "Victories pay Coins. /shop sells 9 consumables and 5 upgradeable relics.\n\n"
    "Commands: /play dashboard · /shop marketplace · /rules full rules · "
    "/app the visual battle arena"
)


RULES = (
    "⚖️ ChronicleRift — Rules & Regulations\n\n"
    "1. Start with /start or /play. Your hero is saved to the Chronicle and only "
    "you can change it.\n"
    "2. One move per turn — Strike (1 EN), Heavy (2 EN), Special (3 EN), Guard, "
    "Scout, or Rest. Attacks spend Rift Energy; the other three are free and "
    "refill it. Without the Energy the attack is refused and the turn is kept.\n"
    "3. The enemy always telegraphs its next move. It will perform exactly that "
    "move after yours — no hidden dice on its side.\n"
    "4. Focus builds 1 per non-attack move (max 3) and is fully spent by your "
    "next Strike for +2 damage each.\n"
    "5. Critical hits apply Burn: 3 damage at the start of each of your next "
    "2 turns.\n"
    "6. Defeat the enemy to advance a chapter and earn Gold, Coins, and Points. "
    "Every 5th chapter is a boss with double rewards.\n"
    "7. Reaching 0 HP sends you back to camp fully healed — progress is never "
    "lost.\n"
    "8. Spend Coins in the Marketplace (/shop): potions are instant, relics are "
    "permanent.\n"
    "9. XP raises your Level; each level increases maximum Vitality and Strike "
    "damage.\n"
    "10. Loot is random. Cleared chapters drop items; bosses roll on a richer "
    "table. Nothing is ever taken from your satchel without your input.\n"
    "11. Relics upgrade to level 5. Each level costs more coins and adds the "
    "same bonus again.\n"
    "12. Heroes are bought with coins in the Mini App; each has its own element, "
    "stats and three attacks. Monsters carry their own ability and scale in "
    "toughness with the chapter.\n"
    "13. One account per player, verified server-side. Automation, spoofing, or "
    "abuse costs you access. Play fair and keep the realm honourable.\n"
)


def build_enemy(chapter: int) -> dict[str, Any]:
    """Spawn the monster that guards ``chapter``, scaled to its toughness curve."""
    monster_id = monster_for_chapter(chapter)
    spec = MONSTERS[monster_id]
    tier = max(0, chapter - 1)
    boss = bool(spec.get("boss"))
    hp = int(spec["hp"] + spec["hp_growth"] * tier)
    if boss:
        hp = int(hp * 1.25)
    enemy = {
        "id": monster_id,
        "name": spec["name"],
        "hp": hp,
        "max_hp": hp,
        "attack": int(spec["attack"] + spec["attack_growth"] * tier),
        "art": spec["emoji"],
        "sprite": spec["art"],
        "element": spec["element"],
        "ability": spec["ability"],
        "level": chapter,
        "boss": boss,
        "intent_index": 0,
    }
    sync_intent(enemy)
    return enemy


def _next_enemy(chapter: int) -> dict[str, Any]:
    """Backwards-compatible alias used by the victory path."""
    return build_enemy(chapter)


def resolve_arena(
    player: dict[str, Any],
    outcome: str,
    hp_left: int | None = None,
    rng: RandomSource | None = None,
) -> TurnResolution:
    """Settle a real-time arena duel against the current chapter monster.

    The arena runs client-side for feel, but rewards stay server-authoritative:
    a win routes through the very same ``_victory`` path as a turn-based kill,
    and a loss simply wakes the hero at camp. ``hp_left`` is clamped into the
    hero's real vitality range so a client can never invent health.
    """
    updated = deepcopy(player)
    ensure_game_defaults(updated)
    game = updated["game"]
    enemy = game["enemy"]
    effects = _fresh_effects("arena", enemy)
    if hp_left is not None:
        game["hp"] = max(1, min(int(game["max_hp"]), int(hp_left)))

    if outcome == "win":
        fallen_name = enemy["name"]
        was_boss = bool(enemy.get("boss", False))
        effects["damage"] = int(enemy["hp"])
        enemy["hp"] = 0
        game["energy"] = game["max_energy"]
        result = _victory(updated, "arena", effects, fallen_name, was_boss, rng)
        # _victory advances the chapter on this same document; keep the
        # career record in step with it.
        game["arena_wins"] = int(game.get("arena_wins", 0)) + 1
        game["best_chapter"] = max(int(game.get("best_chapter", 1)), int(game["chapter"]))
        if was_boss:
            game["boss_kills"] = int(game.get("boss_kills", 0)) + 1
        return result

    game["hp"] = game["max_hp"]
    game["arena_losses"] = int(game.get("arena_losses", 0)) + 1
    game["energy"] = game["max_energy"]
    game["focus"] = 0
    game["burn"] = 0
    game["regen"] = 0
    game["stun"] = 0
    game["exposed_strikes"] = 0
    enemy["hp"] = enemy["max_hp"]
    sync_intent(enemy)
    effects["defeated"] = True
    effects["enemy_intent"] = enemy["intent"]
    summary = (
        f"The {enemy['name']} stands over you. You wake at camp fully healed — "
        "nothing is lost, the duel can be fought again."
    )
    game["last_narrative"] = summary
    return TurnResolution(updated, "arena", summary, victory=False, effects=effects)
