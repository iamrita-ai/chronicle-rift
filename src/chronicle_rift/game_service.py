"""Application service coordinating persistence, mechanics, and narration."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Protocol

from .database import ConcurrentUpdateError
from .game_engine import (
    ItemResolution,
    PurchaseResolution,
    TurnResolution,
    buy_character,
    resolve_arena,
    resolve_purchase,
    resolve_turn,
    select_character,
    sell_item,
    upgrade_relic,
    use_item,
)
from .identity import TelegramIdentity
from .models import apply_owner_unlock, public_player_view


class PlayerStore(Protocol):
    async def get_or_create(
        self, *, user_id: int, first_name: str, username: str | None
    ) -> dict[str, Any]: ...

    async def save_game(
        self, player: dict[str, Any], *, expected_revision: int
    ) -> dict[str, Any]: ...


class Narrator(Protocol):
    async def narrate(self, *, player: dict[str, Any], action: str, summary: str) -> str: ...


class GameBusyError(RuntimeError):
    """Raised after concurrent action retries are exhausted."""


class PurchaseError(RuntimeError):
    """Raised when a shop purchase cannot be completed."""


@dataclass(frozen=True, slots=True)
class GameTurn:
    """Authoritative result from one persisted game action."""

    player: dict[str, Any]
    action: str
    summary: str
    narrative: str
    victory: bool
    effects: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class PurchaseResult:
    """Authoritative result from one persisted shop purchase."""

    player: dict[str, Any]
    item_id: str
    item_name: str
    summary: str
    success: bool
    reason: str | None = None
    effects: dict[str, Any] = field(default_factory=dict)


class GameService:
    """Keeps game mechanics server-side and persists every successful turn."""

    def __init__(
        self,
        store: PlayerStore,
        narrator: Narrator,
        *,
        max_retries: int = 3,
        owner_ids: frozenset[int] = frozenset(),
    ) -> None:
        self._store = store
        self._narrator = narrator
        self._max_retries = max_retries
        self._owner_ids = owner_ids

    def is_owner(self, identity: TelegramIdentity) -> bool:
        return identity.user_id in self._owner_ids

    async def dashboard(self, identity: TelegramIdentity) -> dict[str, Any]:
        """Load or initialize a durable hero profile for an authenticated user."""
        player = await self._store.get_or_create(
            user_id=identity.user_id,
            first_name=identity.first_name,
            username=identity.username,
        )
        if self.is_owner(identity):
            apply_owner_unlock(player)
        return player

    async def player_view(self, identity: TelegramIdentity) -> dict[str, Any]:
        return public_player_view(await self.dashboard(identity))

    async def take_turn(self, identity: TelegramIdentity, action: str) -> GameTurn:
        """Resolve, narrate, and atomically save a turn with conflict retries."""
        last_conflict: ConcurrentUpdateError | None = None
        for _ in range(self._max_retries):
            current = await self.dashboard(identity)
            resolution: TurnResolution = resolve_turn(current, action)
            narrative = await self._narrator.narrate(
                player=resolution.player, action=action, summary=resolution.summary
            )
            resolution.player["game"]["last_narrative"] = narrative
            try:
                saved = await self._store.save_game(
                    resolution.player, expected_revision=current["revision"]
                )
            except ConcurrentUpdateError as exc:
                last_conflict = exc
                continue
            return GameTurn(
                player=saved,
                action=action,
                summary=resolution.summary,
                narrative=narrative,
                victory=resolution.victory,
                effects=resolution.effects,
            )
        raise GameBusyError(
            "Your chronicle changed in another window. Please try again."
        ) from last_conflict

    async def arena_finish(
        self, identity: TelegramIdentity, outcome: str, hp_left: int | None = None
    ) -> GameTurn:
        """Persist the outcome of a real-time arena duel with conflict retries."""
        last_conflict: ConcurrentUpdateError | None = None
        for _ in range(self._max_retries):
            current = await self.dashboard(identity)
            resolution = resolve_arena(current, outcome, hp_left)
            narrative = await self._narrator.narrate(
                player=resolution.player, action="arena", summary=resolution.summary
            )
            resolution.player["game"]["last_narrative"] = narrative
            try:
                saved = await self._store.save_game(
                    resolution.player, expected_revision=current["revision"]
                )
            except ConcurrentUpdateError as exc:
                last_conflict = exc
                continue
            return GameTurn(
                player=saved,
                action="arena",
                summary=resolution.summary,
                narrative=narrative,
                victory=resolution.victory,
                effects=resolution.effects,
            )
        raise GameBusyError(
            "Your chronicle changed in another window. Please try again."
        ) from last_conflict

    async def buy_item(self, identity: TelegramIdentity, item_id: str) -> PurchaseResult:
        """Spend coins on a shop item and atomically save with conflict retries."""
        last_conflict: ConcurrentUpdateError | None = None
        for _ in range(self._max_retries):
            current = await self.dashboard(identity)
            resolution: PurchaseResolution = resolve_purchase(current, item_id)
            if not resolution.success:
                return PurchaseResult(
                    player=current,
                    item_id=resolution.item_id,
                    item_name=resolution.item_name,
                    summary=resolution.summary,
                    success=False,
                    reason=resolution.reason,
                )
            try:
                saved = await self._store.save_game(
                    resolution.player, expected_revision=current["revision"]
                )
            except ConcurrentUpdateError as exc:
                last_conflict = exc
                continue
            return PurchaseResult(
                player=saved,
                item_id=resolution.item_id,
                item_name=resolution.item_name,
                summary=resolution.summary,
                success=True,
            )
        raise GameBusyError(
            "Your chronicle changed in another window. Please try again."
        ) from last_conflict

    async def use_item(self, identity: TelegramIdentity, item_id: str) -> PurchaseResult:
        """Consume a satchel item (free action) and persist the result."""
        return await self._apply_item_op(identity, item_id, lambda p: use_item(p, item_id))

    async def sell_item(
        self, identity: TelegramIdentity, item_id: str, quantity: int = 1
    ) -> PurchaseResult:
        """Sell satchel items for coins and persist the result."""
        return await self._apply_item_op(
            identity, item_id, lambda p: sell_item(p, item_id, quantity)
        )

    async def upgrade_relic(self, identity: TelegramIdentity, item_id: str) -> PurchaseResult:
        """Spend coins to raise a relic's level and persist the result."""
        return await self._apply_item_op(identity, item_id, lambda p: upgrade_relic(p, item_id))

    async def buy_character(self, identity: TelegramIdentity, character_id: str) -> PurchaseResult:
        """Buy a playable character with coins."""
        return await self._apply_item_op(
            identity, character_id, lambda p: buy_character(p, character_id)
        )

    async def select_character(
        self, identity: TelegramIdentity, character_id: str
    ) -> PurchaseResult:
        """Switch the active character."""
        return await self._apply_item_op(
            identity, character_id, lambda p: select_character(p, character_id)
        )

    async def _apply_item_op(
        self,
        identity: TelegramIdentity,
        item_id: str,
        operation: Callable[[dict[str, Any]], ItemResolution],
    ) -> PurchaseResult:
        last_conflict: ConcurrentUpdateError | None = None
        for _ in range(self._max_retries):
            current = await self.dashboard(identity)
            resolution = operation(current)
            if not resolution.success:
                return PurchaseResult(
                    player=current,
                    item_id=resolution.item_id,
                    item_name=resolution.item_name,
                    summary=resolution.summary,
                    success=False,
                    reason=resolution.reason,
                    effects=resolution.effects,
                )
            try:
                saved = await self._store.save_game(
                    resolution.player, expected_revision=current["revision"]
                )
            except ConcurrentUpdateError as exc:
                last_conflict = exc
                continue
            return PurchaseResult(
                player=saved,
                item_id=resolution.item_id,
                item_name=resolution.item_name,
                summary=resolution.summary,
                success=True,
                effects=resolution.effects,
            )
        raise GameBusyError(
            "Your chronicle changed in another window. Please try again."
        ) from last_conflict

    async def save_feedback(self, identity: TelegramIdentity, kind: str, text: str) -> None:
        """Persist a player feedback note; the store may lack the sink in tests."""
        saver = getattr(self._store, "insert_feedback", None)
        if saver is None:
            return
        await saver(user_id=identity.user_id, first_name=identity.first_name, kind=kind, text=text)
