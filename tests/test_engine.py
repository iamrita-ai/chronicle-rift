from __future__ import annotations

from copy import deepcopy

from chronicle_rift.game_engine import resolve_purchase, resolve_turn
from chronicle_rift.models import new_player


class FixedRandom:
    def __init__(self, value: int) -> None:
        self.value = value

    def randint(self, start: int, stop: int) -> int:
        assert start <= self.value <= stop
        return self.value


class QueuedRandom:
    """Plays back scripted rolls so crits and boss paths can be tested."""

    def __init__(self, rolls: list[int]) -> None:
        self._rolls = list(rolls)

    def randint(self, start: int, stop: int) -> int:
        value = self._rolls.pop(0)
        assert start <= value <= stop
        return value


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
    assert "absorbs" in result.summary


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


def test_purchase_is_rejected_when_coins_are_insufficient() -> None:
    player = new_player(user_id=7, first_name="Rita", username=None)
    player["game"]["coins"] = 0

    result = resolve_purchase(player, "blade")

    assert result.success is False
    assert result.reason == "insufficient_coins"
    assert result.player["game"]["attack_bonus"] == 0


def test_purchase_rejects_a_heal_at_full_hp() -> None:
    player = new_player(user_id=7, first_name="Rita", username=None)
    player["game"]["hp"] = player["game"]["max_hp"]

    result = resolve_purchase(player, "heal")

    assert result.success is False
    assert result.reason == "already_full"


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
    # Damage: 4 + level 1 + 2 exposure bonus = 7.
    assert struck.effects["exposed_used"] is True
    assert struck.effects["damage"] == 7
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
