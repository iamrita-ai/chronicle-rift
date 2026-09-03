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
    level_up_evils,
    resolve_arena,
    resolve_purchase,
    resolve_turn,
    select_character,
    sell_item,
    upgrade_attribute,
    upgrade_power,
    upgrade_relic,
    use_item,
)
from .identity import TelegramIdentity
from .models import (
    ATTRIBUTE_IDS,
    CHARACTERS,
    MAX_RELIC_LEVEL,
    RELIC_IDS,
    public_player_view,
)

OWNER_TEST_COINS = 100_000
OWNER_TEST_POINTS = 1000


def apply_owner_unlocks(game: dict[str, Any]) -> bool:
    """Give the owner everything, for testing. Idempotent; returns True on change.

    The unlocked state is applied in memory on load and persists with the
    next regular save, so purchases and turns keep working unchanged.
    """
    changed = False
    if not game.get("owner_mode"):
        game["owner_mode"] = True
        changed = True
    if int(game.get("coins", 0)) < OWNER_TEST_COINS:
        game["coins"] = OWNER_TEST_COINS
        changed = True
    if int(game.get("attribute_points", 0)) < OWNER_TEST_POINTS:
        game["attribute_points"] = OWNER_TEST_POINTS
        changed = True
    attributes = dict(game.get("attributes") or {})
    if any(int(attributes.get(key, 0)) <= 0 for key in ATTRIBUTE_IDS):
        game["attributes"] = {key: 10 for key in ATTRIBUTE_IDS} | {
            k: max(int(v), 10) for k, v in attributes.items() if k in ATTRIBUTE_IDS
        }
        changed = True
    owned = list(dict.fromkeys(game.get("owned_characters") or []))
    if not set(CHARACTERS) <= set(owned):
        game["owned_characters"] = sorted(set(owned) | set(CHARACTERS), key=list(CHARACTERS).index)
        changed = True
    relics = dict(game.get("relics") or {})
    if any(int(relics.get(relic_id, 0)) < MAX_RELIC_LEVEL for relic_id in RELIC_IDS):
        game["relics"] = {
            **{relic_id: MAX_RELIC_LEVEL for relic_id in RELIC_IDS},
            **{k: max(int(v), MAX_RELIC_LEVEL) for k, v in relics.items()},
        }
        changed = True
    return changed


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
        owner_user_id: int | None = None,
    ) -> None:
        self._store = store
        self._narrator = narrator
        self._max_retries = max_retries
        self._owner_user_id = owner_user_id

    async def dashboard(self, identity: TelegramIdentity) -> dict[str, Any]:
        """Load or initialize a durable hero profile for an authenticated user."""
        player = await self._store.get_or_create(
            user_id=identity.user_id,
            first_name=identity.first_name,
            username=identity.username,
        )
        if self._owner_user_id is not None and identity.user_id == self._owner_user_id:
            # Owner test mode: every hero, relic and a full purse of coins.
            apply_owner_unlocks(player["game"])
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

    async def train_attribute(self, identity: TelegramIdentity, stat_key: str) -> PurchaseResult:
        """Spend one earned Attribute Point on a single training track."""
        return await self._apply_item_op(
            identity, stat_key, lambda p: upgrade_attribute(p, stat_key)
        )

    async def buy_power(self, identity: TelegramIdentity, power_key: str) -> PurchaseResult:
        """Buy the next level of a single power with coins (cost rises per level)."""
        return await self._apply_item_op(
            identity, power_key, lambda p: upgrade_power(p, power_key)
        )

    async def ascend_evils(self, identity: TelegramIdentity) -> PurchaseResult:
        """Pay gold to raise the realm's Evil tier so slain evils return levelled up."""
        return await self._apply_item_op(identity, "evils", level_up_evils)

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
