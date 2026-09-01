from __future__ import annotations

from copy import deepcopy

from chronicle_rift.game_engine import resolve_purchase, resolve_turn
from chronicle_rift.models import new_player


class FixedRandom:
    """Returns the same roll every time, clamped into each requested range."""

    def __init__(self, value: int) -> None:
        self.value = value

    def randint(self, start: int, stop: int) -> int:
        return max(start, min(stop, self.value))


class QueuedRandom:
    """Plays back scripted rolls so crits and boss paths can be tested."""

    def __init__(self, rolls: list[int]) -> None:
        self._rolls = list(rolls)

    def randint(self, start: int, stop: int) -> int:
        # Loot rolls happen after combat rolls; tests only script what they
        # care about and anything extra takes the minimum of the range.
        while self._rolls:
            value = self._rolls.pop(0)
            if start <= value <= stop:
                return value
        return start


def test_strike_is_immutable_and_applies_both_sides() -> None:
    player = new_player(user_id=7, first_name="Rita", username="rita")
    original = deepcopy(player)

    result = resolve_turn(player, "strike", FixedRandom(5))

    assert player == original
    assert result.player["game"]["energy"] == 4
    assert result.player["game"]["enemy"]["hp"] == 12
    assert result.player["game"]["hp"] == 19
    assert result.victory is False


def test_victory_advances_chapter_and_persists_rewards() -> None:
    player = new_player(user_id=7, first_name="Rita", username=None)
    player["game"]["enemy"]["hp"] = 1
    player["game"]["xp"] = 19

    result = resolve_turn(player, "strike", FixedRandom(4))
    game = result.player["game"]

    assert result.victory is True
    assert game["chapter"] == 2
    assert game["gold"] == 38
    assert game["level"] == 2
    assert game["enemy"]["name"] == "Rift Stalker"


def test_guard_reduces_incoming_damage_and_restores_energy() -> None:
    player = new_player(user_id=7, first_name="Rita", username=None)
    player["game"]["energy"] = 2

    result = resolve_turn(player, "guard", FixedRandom(5))

    assert result.player["game"]["energy"] == 3
    assert result.player["game"]["hp"] == 24
    assert "swallows" in result.summary


def test_victory_awards_coins_and_points() -> None:
    player = new_player(user_id=7, first_name="Rita", username=None)
    player["game"]["enemy"]["hp"] = 1

    result = resolve_turn(player, "strike", FixedRandom(4))
    game = result.player["game"]

    assert result.victory is True
    assert game["coins"] > new_player(user_id=7, first_name="Rita", username=None)["game"]["coins"]
    assert game["points"] > 0


def test_purchase_spends_coins_and_applies_an_upgrade() -> None:
    player = new_player(user_id=7, first_name="Rita", username=None)
    player["game"]["coins"] = 100
    result = resolve_purchase(player, "blade")

    assert result.success is True
    assert result.player["game"]["coins"] == 100 - 60
    assert result.player["game"]["attack_bonus"] == 2
    assert result.player["game"]["relics"]["blade"] == 1


def test_purchase_is_rejected_when_coins_are_insufficient() -> None:
    player = new_player(user_id=7, first_name="Rita", username=None)
    player["game"]["coins"] = 0

    result = resolve_purchase(player, "blade")

    assert result.success is False
    assert result.reason == "insufficient_coins"
    assert result.player["game"]["attack_bonus"] == 0


def test_using_a_potion_at_full_hp_is_refused() -> None:
    from chronicle_rift.game_engine import use_item

    player = new_player(user_id=7, first_name="Rita", username=None)
    player["game"]["hp"] = player["game"]["max_hp"]
    player["game"]["inventory"]["draught"] = 1

    result = use_item(player, "draught")

    assert result.success is False
    assert result.reason == "already_full"
    assert result.player["game"]["inventory"]["draught"] == 1


def test_perfect_strike_roll_is_a_critical_hit() -> None:
    """A top-of-range roll (8) lands a crit worth 1.5x damage."""
    player = new_player(user_id=7, first_name="Rita", username=None)

    result = resolve_turn(player, "strike", QueuedRandom([8, 2]))
    game = result.player["game"]

    # Damage: round((8 + level 1) * 1.5) = 14; enemy 18 - 14 = 4.
    assert result.effects["crit"] is True
    assert result.effects["damage"] == 14
    assert game["enemy"]["hp"] == 4
    assert "CRITICAL" in result.summary


def test_scout_exposes_enemy_and_buffs_next_strike() -> None:
    """Scouting grants insight and +2 damage on the next Strike."""
    player = new_player(user_id=7, first_name="Rita", username=None)

    scouted = resolve_turn(player, "scout", QueuedRandom([2, 2]))
    assert scouted.effects["insight"] == 2
    assert scouted.player["game"]["exposed_strikes"] == 1

    struck = resolve_turn(scouted.player, "strike", QueuedRandom([4, 2]))
    # Damage: 4 + level 1 + 2 exposure bonus + 1 Focus x2 = 9.
    assert struck.effects["exposed_used"] is True
    assert struck.effects["focus_spent"] == 1
    assert struck.effects["damage"] == 9
    assert struck.player["game"]["exposed_strikes"] == 0


def test_perfect_ward_reflects_damage() -> None:
    player = new_player(user_id=7, first_name="Rita", username=None)

    result = resolve_turn(player, "guard", QueuedRandom([5, 2]))

    assert result.effects["reflect"] == 2
    assert result.player["game"]["enemy"]["hp"] == 16
    assert result.player["game"]["hp"] == 24


def test_every_fifth_chapter_spawns_a_boss_with_double_rewards() -> None:
    player = new_player(user_id=7, first_name="Rita", username=None)
    player["game"]["chapter"] = 4
    player["game"]["enemy"]["hp"] = 1

    result = resolve_turn(player, "strike", QueuedRandom([4]))
    game = result.player["game"]

    assert result.victory is True
    assert game["chapter"] == 5
    assert game["enemy"]["boss"] is True
    assert game["enemy"]["name"] == "Ebon Colossus"
    assert game["enemy"]["max_hp"] > 18 + 4 * 5


def test_boss_victory_doubles_rewards() -> None:
    player = new_player(user_id=7, first_name="Rita", username=None)
    player["game"]["chapter"] = 5
    player["game"]["enemy"] = {
        "name": "Ebon Colossus",
        "hp": 1,
        "max_hp": 61,
        "attack": 11,
        "art": "🌑",
        "boss": True,
    }
    coins_before = player["game"]["coins"]

    result = resolve_turn(player, "strike", QueuedRandom([4]))

    assert result.victory is True
    assert result.player["game"]["coins"] - coins_before == (8 + 5 * 2) * 2
    assert result.effects["gold_gained"] == (10 + 5 * 3) * 2


def test_enemy_intent_is_telegraphed_and_follows_a_fixed_pattern() -> None:
    """Players can always see the enemy's next move before committing."""
    player = new_player(user_id=7, first_name="Rita", username=None)
    intent = resolve_turn(player, "scout", FixedRandom(2)).effects["enemy_intent"]

    # Ash Warden rotation is slash, slash, heavy — after one turn the next
    # telegraphed move is the second Slash.
    assert intent["id"] == "slash"
    assert intent["damage"] == 5

    second = resolve_turn(
        resolve_turn(player, "scout", FixedRandom(2)).player, "scout", FixedRandom(2)
    )
    assert second.effects["enemy_intent"]["id"] == "heavy"
    assert second.effects["enemy_intent"]["damage"] == 9
    assert "Heavy Blow" in second.summary


def test_guard_blocks_the_telegraphed_heavy_blow() -> None:
    player = new_player(user_id=7, first_name="Rita", username=None)
    player["game"]["enemy"]["intent_index"] = 2  # Heavy Blow is next.

    result = resolve_turn(player, "guard", FixedRandom(4))

    assert result.effects["blocked"] == 4
    assert result.effects["enemy_damage"] == 5
    assert result.player["game"]["hp"] == 19


def test_focus_builds_on_setup_moves_and_is_spent_by_strike() -> None:
    player = new_player(user_id=7, first_name="Rita", username=None)

    rested = resolve_turn(player, "rest", FixedRandom(4))
    guarded = resolve_turn(rested.player, "guard", FixedRandom(2))
    assert guarded.player["game"]["focus"] == 2

    struck = resolve_turn(guarded.player, "strike", FixedRandom(4))
    # 4 roll + level 1 + 2 Focus x2 = 9 damage, and the meter empties.
    assert struck.effects["focus_spent"] == 2
    assert struck.effects["damage"] == 9
    assert struck.player["game"]["focus"] == 0


def test_critical_hit_applies_burn_that_ticks_next_turn() -> None:
    player = new_player(user_id=7, first_name="Rita", username=None)

    crit = resolve_turn(player, "strike", FixedRandom(8))
    assert crit.player["game"]["burn"] == 2

    after = resolve_turn(crit.player, "rest", FixedRandom(4))
    assert after.effects["burn_damage"] == 3
    assert after.player["game"]["burn"] == 1


def test_mend_intent_heals_the_enemy() -> None:
    player = new_player(user_id=7, first_name="Rita", username=None)
    player["game"]["enemy"] = {
        "name": "Rift Stalker",
        "hp": 10,
        "max_hp": 23,
        "attack": 6,
        "art": "🜂",
        "boss": False,
        "intent_index": 2,  # Mend
    }

    result = resolve_turn(player, "guard", FixedRandom(2))

    assert result.effects["enemy_healed"] == 5
    assert result.effects["enemy_damage"] == 0
    assert result.player["game"]["enemy"]["hp"] == 15


def test_public_view_exposes_intent_focus_and_finisher_hint() -> None:
    from chronicle_rift.models import public_player_view

    player = new_player(user_id=7, first_name="Rita", username=None)
    player["game"]["enemy"]["hp"] = 3
    view = public_player_view(player)

    assert view["enemy"]["intent"]["name"] == "Slash"
    assert view["hero"]["max_focus"] == 3
    assert view["battle"]["can_finish"] is True


def test_victory_drops_random_loot_into_the_satchel() -> None:
    player = new_player(user_id=7, first_name="Rita", username=None)
    player["game"]["enemy"]["hp"] = 1
    before = sum(player["game"]["inventory"].values())

    result = resolve_turn(player, "strike", FixedRandom(4))

    assert result.victory is True
    assert result.effects["loot"]
    assert sum(result.player["game"]["inventory"].values()) > before


def test_relics_can_be_upgraded_and_stack_their_bonus() -> None:
    from chronicle_rift.game_engine import upgrade_relic

    player = new_player(user_id=7, first_name="Rita", username=None)
    player["game"]["coins"] = 500
    owned = resolve_purchase(player, "blade").player
    upgraded = upgrade_relic(owned, "blade")

    assert upgraded.success is True
    assert upgraded.player["game"]["relics"]["blade"] == 2
    assert upgraded.player["game"]["attack_bonus"] == 4


def test_ember_heart_raises_maximum_vitality() -> None:
    player = new_player(user_id=7, first_name="Rita", username=None)
    player["game"]["coins"] = 500
    result = resolve_purchase(player, "heart")

    assert result.player["game"]["max_hp"] == 24 + 5


def test_items_can_be_used_and_sold() -> None:
    from chronicle_rift.game_engine import sell_item, use_item

    player = new_player(user_id=7, first_name="Rita", username=None)
    player["game"]["hp"] = 10
    player["game"]["inventory"]["greater_draught"] = 1

    used = use_item(player, "greater_draught")
    assert used.success is True
    assert used.player["game"]["hp"] == 24
    assert "greater_draught" not in used.player["game"]["inventory"]

    sold = sell_item(used.player, "salve", 2)
    assert sold.success is True
    assert sold.player["game"]["coins"] == 30 + 10
    assert "salve" not in sold.player["game"]["inventory"]


def test_grenade_can_finish_a_fight_without_costing_a_turn() -> None:
    from chronicle_rift.game_engine import use_item

    player = new_player(user_id=7, first_name="Rita", username=None)
    player["game"]["enemy"]["hp"] = 5
    player["game"]["inventory"]["bomb"] = 1

    result = use_item(player, "bomb")

    assert result.success is True
    assert result.effects["victory"] is True
    assert result.player["game"]["chapter"] == 2


def test_veil_powder_makes_the_enemy_miss() -> None:
    from chronicle_rift.game_engine import use_item

    player = new_player(user_id=7, first_name="Rita", username=None)
    player["game"]["inventory"]["smoke"] = 1
    veiled = use_item(player, "smoke").player

    result = resolve_turn(veiled, "strike", FixedRandom(4))

    assert result.effects["stunned"] is True
    assert result.effects["enemy_damage"] == 0
    assert result.player["game"]["hp"] == 24


def test_legacy_documents_migrate_to_the_new_inventory() -> None:
    from chronicle_rift.models import ensure_game_defaults

    legacy = new_player(user_id=7, first_name="Rita", username=None)
    legacy["game"]["inventory"] = ["Rift Compass", "Traveler's Tonic", "Rift Steel"]
    legacy["game"]["purchased"] = ["ward"]
    legacy["game"].pop("relics")

    ensure_game_defaults(legacy)

    assert legacy["game"]["inventory"] == {"ash_shard": 1, "salve": 1}
    assert legacy["game"]["relics"] == {"blade": 1, "ward": 1}
    assert legacy["game"]["attack_bonus"] == 2
    assert legacy["game"]["ward_bonus"] == 2
