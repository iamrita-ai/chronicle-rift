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
    resolve_purchase,
    resolve_turn,
    sell_item,
    upgrade_relic,
    use_item,
)
from .identity import TelegramIdentity
from .models import public_player_view


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

    def __init__(self, store: PlayerStore, narrator: Narrator, *, max_retries: int = 3) -> None:
        self._store = store
        self._narrator = narrator
        self._max_retries = max_retries

    async def dashboard(self, identity: TelegramIdentity) -> dict[str, Any]:
        """Load or initialize a durable hero profile for an authenticated user."""
        return await self._store.get_or_create(
            user_id=identity.user_id,
            first_name=identity.first_name,
            username=identity.username,
        )

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
