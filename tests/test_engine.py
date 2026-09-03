from __future__ import annotations

from copy import deepcopy

from chronicle_rift.game_engine import resolve_arena, resolve_purchase, resolve_turn
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
    # 5 roll + level 1 + power 2 = 8 damage; the tougher Warden starts at 26.
    assert result.player["game"]["enemy"]["hp"] == 18
    assert result.player["game"]["hp"] == 38  # 44 base vitality − the 6-damage Slash
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
    assert game["enemy"]["name"] == "Obsidian Herald"


def test_guard_reduces_incoming_damage_and_restores_energy() -> None:
    player = new_player(user_id=7, first_name="Rita", username=None)
    player["game"]["energy"] = 2

    result = resolve_turn(player, "guard", FixedRandom(5))

    assert result.player["game"]["energy"] == 3
    # A perfect ward (5) still lets 1 point of the beefed-up Slash through.
    assert result.player["game"]["hp"] == 43
    assert result.effects["blocked"] == 5
    assert "answers with Slash: 1 damage (5 blocked by your ward)" in result.summary


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

    # Damage: round((8 + level 1 + power 2) * 1.5) = 16; enemy 26 - 16 = 10.
    assert result.effects["crit"] is True
    assert result.effects["damage"] == 16
    assert game["enemy"]["hp"] == 10
    assert "CRITICAL" in result.summary


def test_scout_exposes_enemy_and_buffs_next_strike() -> None:
    """Scouting grants insight and +2 damage on the next Strike."""
    player = new_player(user_id=7, first_name="Rita", username=None)

    scouted = resolve_turn(player, "scout", QueuedRandom([2, 2]))
    assert scouted.effects["insight"] == 2
    assert scouted.player["game"]["exposed_strikes"] == 1

    struck = resolve_turn(scouted.player, "strike", QueuedRandom([4, 2]))
    # Damage: 4 + level 1 + power 2 + 2 exposure + 1 Focus x2 = 11.
    assert struck.effects["exposed_used"] is True
    assert struck.effects["focus_spent"] == 1
    assert struck.effects["damage"] == 11
    assert struck.player["game"]["exposed_strikes"] == 0


def test_perfect_ward_reflects_damage() -> None:
    player = new_player(user_id=7, first_name="Rita", username=None)

    result = resolve_turn(player, "guard", QueuedRandom([5, 2]))

    assert result.effects["reflect"] == 2
    assert result.player["game"]["enemy"]["hp"] == 24  # 26 − 2 reflect
    assert result.player["game"]["hp"] == 43  # ward 5 vs a 6-damage slash


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
    assert intent["damage"] == 6

    second = resolve_turn(
        resolve_turn(player, "scout", FixedRandom(2)).player, "scout", FixedRandom(2)
    )
    assert second.effects["enemy_intent"]["id"] == "heavy"
    assert second.effects["enemy_intent"]["damage"] == 10
    assert "Heavy Blow" in second.summary


def test_guard_blocks_the_telegraphed_heavy_blow() -> None:
    player = new_player(user_id=7, first_name="Rita", username=None)
    player["game"]["enemy"]["intent_index"] = 2  # Heavy Blow is next.

    result = resolve_turn(player, "guard", FixedRandom(4))

    assert result.effects["blocked"] == 4
    assert result.effects["enemy_damage"] == 6  # heavy 10 − ward 4
    assert result.player["game"]["hp"] == 38


def test_focus_builds_on_setup_moves_and_is_spent_by_strike() -> None:
    player = new_player(user_id=7, first_name="Rita", username=None)

    rested = resolve_turn(player, "rest", FixedRandom(4))
    guarded = resolve_turn(rested.player, "guard", FixedRandom(2))
    assert guarded.player["game"]["focus"] == 2

    struck = resolve_turn(guarded.player, "strike", FixedRandom(4))
    # 4 roll + level 1 + power 2 + 2 Focus x2 = 11 damage, meter empties.
    assert struck.effects["focus_spent"] == 2
    assert struck.effects["damage"] == 11
    assert struck.player["game"]["focus"] == 0


def test_critical_hit_applies_burn_that_ticks_next_turn() -> None:
    player = new_player(user_id=7, first_name="Rita", username=None)
    player["game"]["enemy"]["hp"] = 60  # survive the crit so burn can tick
    player["game"]["enemy"]["max_hp"] = 60

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

    assert result.player["game"]["max_hp"] == 44 + 5


def test_items_can_be_used_and_sold() -> None:
    from chronicle_rift.game_engine import sell_item, use_item

    player = new_player(user_id=7, first_name="Rita", username=None)
    player["game"]["hp"] = 10
    player["game"]["inventory"]["greater_draught"] = 1

    used = use_item(player, "greater_draught")
    assert used.success is True
    assert used.player["game"]["hp"] == 40  # 10 + 30, under the new 44 cap
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
    assert result.player["game"]["hp"] == 44


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


def test_each_character_has_three_distinct_attacks() -> None:
    from chronicle_rift.models import CHARACTERS

    for character in CHARACTERS.values():
        assert set(character["attacks"]) == {"strike", "heavy", "special"}
        costs = [attack["cost"] for attack in character["attacks"].values()]
        assert costs == [1, 2, 3]


def test_heavy_attack_costs_two_energy_and_hits_harder() -> None:
    player = new_player(user_id=7, first_name="Rita", username=None)

    result = resolve_turn(player, "heavy", FixedRandom(10))

    assert result.player["game"]["energy"] == 3
    assert result.effects["damage"] == 13  # 10 + level 1 + power 2
    assert "Molten Cleave" in result.summary


def test_fire_special_burns_and_ice_special_freezes() -> None:
    from chronicle_rift.models import ensure_game_defaults

    fire = new_player(user_id=7, first_name="Rita", username=None)
    burned = resolve_turn(fire, "special", FixedRandom(6))
    assert burned.player["game"]["burn"] == 3
    assert burned.effects["special"] == "fire"

    ice = new_player(user_id=8, first_name="Rita", username=None)
    ice["game"]["character"] = "frostward"
    ice["game"]["owned_characters"] = ["emberblade", "frostward"]
    ensure_game_defaults(ice)
    assert ice["game"]["max_hp"] == 56

    # The freeze eats the counterattack that would have landed this turn.
    frozen = resolve_turn(ice, "special", FixedRandom(5))
    assert frozen.effects["stunned"] is True
    assert frozen.effects["enemy_damage"] == 0


def test_arcane_special_pierces_wards_and_heals() -> None:
    from chronicle_rift.models import ensure_game_defaults

    player = new_player(user_id=7, first_name="Rita", username=None)
    player["game"]["character"] = "arcanist"
    player["game"]["owned_characters"] = ["emberblade", "arcanist"]
    player["game"]["hp"] = 5
    ensure_game_defaults(player)

    result = resolve_turn(player, "special", FixedRandom(7))

    assert result.effects["pierce"] is True
    assert result.effects["healed"] > 0


def test_attacks_are_refused_without_enough_energy() -> None:
    player = new_player(user_id=7, first_name="Rita", username=None)
    player["game"]["energy"] = 2

    result = resolve_turn(player, "special", FixedRandom(6))

    assert result.effects["blocked_action"] is True
    assert result.player["game"]["energy"] == 2
    assert result.player["game"]["enemy"]["hp"] == 26


def test_monsters_scale_and_carry_their_own_ability() -> None:
    from chronicle_rift.game_engine import build_enemy

    early = build_enemy(1)
    late = build_enemy(9)
    boss = build_enemy(5)

    assert early["name"] == "Ash Warden"
    assert late["max_hp"] > early["max_hp"]
    assert late["attack"] > early["attack"]
    assert boss["boss"] is True
    assert boss["ability"]
    assert early["sprite"] == "mob-ash-warden"


def test_arena_win_clears_the_chapter_and_drops_loot() -> None:
    player = new_player(user_id=42, first_name="Duelist", username=None)
    chapter_before = player["game"]["chapter"]
    result = resolve_arena(player, "win", hp_left=7)

    assert result.victory is True
    assert result.player["game"]["chapter"] == chapter_before + 1
    assert result.player["game"]["hp"] == 7
    assert result.effects["loot"]
    assert result.effects["coins_gained"] > 0
    # the input document is never mutated
    assert player["game"]["chapter"] == chapter_before


def test_arena_loss_wakes_the_hero_at_camp() -> None:
    player = new_player(user_id=43, first_name="Duelist", username=None)
    player["game"]["hp"] = 2
    player["game"]["enemy"]["hp"] = 3
    result = resolve_arena(player, "lose")

    assert result.victory is False
    assert result.effects["defeated"] is True
    assert result.player["game"]["hp"] == result.player["game"]["max_hp"]
    assert result.player["game"]["enemy"]["hp"] == result.player["game"]["enemy"]["max_hp"]
    assert result.player["game"]["chapter"] == player["game"]["chapter"]


def test_arena_cannot_invent_health() -> None:
    player = new_player(user_id=44, first_name="Duelist", username=None)
    result = resolve_arena(player, "win", hp_left=9999)
    assert result.player["game"]["hp"] == result.player["game"]["max_hp"]


def test_arena_win_keeps_the_career_record() -> None:
    player = new_player(user_id=45, first_name="Duelist", username=None)
    result = resolve_arena(player, "win", hp_left=7)
    game = result.player["game"]
    assert game["arena_wins"] == 1
    assert game["boss_kills"] == 0
    assert game["best_chapter"] == game["chapter"] == 2

    # a boss kill is counted separately: feed the *resulting* player forward
    # and mark its enemy a boss before the next duel.
    player = result.player
    player["game"]["enemy"]["boss"] = True
    result = resolve_arena(player, "win", hp_left=7)
    assert result.player["game"]["arena_wins"] == 2
    assert result.player["game"]["boss_kills"] == 1
    assert result.player["game"]["best_chapter"] == result.player["game"]["chapter"]


def test_arena_loss_counts_a_defeat() -> None:
    player = new_player(user_id=46, first_name="Duelist", username=None)
    result = resolve_arena(player, "lose")
    assert result.player["game"]["arena_losses"] == 1
    assert result.player["game"]["arena_wins"] == 0


def test_public_view_exposes_profile_and_record() -> None:
    from chronicle_rift.models import public_player_view

    player = new_player(user_id=47, first_name="Duelist", username="duelist")
    view = public_player_view(player)
    assert view["profile"]["hero_name"] == "Duelist"
    assert view["profile"]["username"] == "duelist"
    assert view["record"] == {
        "wins": 0, "losses": 0, "boss_kills": 0, "chapter": 1, "best_chapter": 1,
        "evil_tier": 1,
    }
