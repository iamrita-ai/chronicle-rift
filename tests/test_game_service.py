from __future__ import annotations

from copy import deepcopy

import pytest

from chronicle_rift.database import ConcurrentUpdateError
from chronicle_rift.game_service import GameService
from chronicle_rift.identity import TelegramIdentity
from chronicle_rift.models import new_player


class MemoryStore:
    def __init__(self) -> None:
        self.player = new_player(user_id=11, first_name="Rita", username="rift")
        self.conflicts_remaining = 0

    async def get_or_create(self, *, user_id: int, first_name: str, username: str | None):
        assert user_id == 11
        return deepcopy(self.player)

    async def save_game(self, player, *, expected_revision: int):
        if self.conflicts_remaining:
            self.conflicts_remaining -= 1
            self.player["revision"] += 1
            raise ConcurrentUpdateError("conflict")
        assert expected_revision == self.player["revision"]
        self.player = deepcopy(player)
        self.player["revision"] += 1
        return deepcopy(self.player)


class TestNarrator:
    async def narrate(self, *, player, action: str, summary: str) -> str:
        del player, summary
        return f"Narrated {action} through the ember gate."


@pytest.mark.asyncio
async def test_turn_is_narrated_and_saved() -> None:
    store = MemoryStore()
    service = GameService(store, TestNarrator())

    turn = await service.take_turn(TelegramIdentity(11, "Rita", "rift"), "scout")

    assert turn.narrative == "Narrated scout through the ember gate."
    assert store.player["game"]["last_narrative"] == turn.narrative
    assert turn.player["revision"] == 2
    assert store.player["game"]["energy"] == 5


@pytest.mark.asyncio
async def test_turn_retries_once_after_a_concurrent_update() -> None:
    store = MemoryStore()
    store.conflicts_remaining = 1
    service = GameService(store, TestNarrator())

    turn = await service.take_turn(TelegramIdentity(11, "Rita", "rift"), "rest")

    assert turn.action == "rest"
    assert store.player["revision"] == 3


@pytest.mark.asyncio
async def test_purchase_spends_coins_and_saves() -> None:
    store = MemoryStore()
    store.player["game"]["coins"] = 100
    service = GameService(store, TestNarrator())

    result = await service.buy_item(TelegramIdentity(11, "Rita", "rift"), "blade")

    assert result.success is True
    assert result.player["game"]["coins"] == store.player["game"]["coins"]
    assert store.player["game"]["coins"] == 100 - 60
    assert store.player["revision"] == 2


@pytest.mark.asyncio
async def test_purchase_returns_failure_without_saving_when_unaffordable() -> None:
    store = MemoryStore()
    store.player["game"]["coins"] = 0
    service = GameService(store, TestNarrator())

    result = await service.buy_item(TelegramIdentity(11, "Rita", "rift"), "blade")

    assert result.success is False
    assert result.reason == "insufficient_coins"
    assert store.player["revision"] == 1


@pytest.mark.asyncio
async def test_owner_gets_fully_unlocked_chronicle() -> None:
    store = MemoryStore()
    service = GameService(store, TestNarrator(), owner_ids=frozenset({11}))

    view = await service.player_view(TelegramIdentity(11, "Rita", "rift"))

    assert view["owner"] is True
    assert all(card["owned"] for card in view["roster"])
    assert view["hero"]["coins"] >= 1_000_000
    assert service.is_owner(TelegramIdentity(11, "Rita", "rift"))
    assert not service.is_owner(TelegramIdentity(12, "Not", "owner"))


@pytest.mark.asyncio
async def test_regular_player_stays_locked() -> None:
    store = MemoryStore()
    service = GameService(store, TestNarrator(), owner_ids=frozenset({99}))

    view = await service.player_view(TelegramIdentity(11, "Rita", "rift"))

    assert view["owner"] is False
    assert not all(card["owned"] for card in view["roster"])
