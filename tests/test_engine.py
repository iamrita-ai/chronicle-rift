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
