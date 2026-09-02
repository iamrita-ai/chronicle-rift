"""Async MongoDB persistence for player progression."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from pymongo import AsyncMongoClient, ReturnDocument
from pymongo.asynchronous.collection import AsyncCollection
from pymongo.errors import DuplicateKeyError, PyMongoError

from .models import ensure_game_defaults, new_player


class DatabaseUnavailable(RuntimeError):
    """Raised when MongoDB cannot serve a required operation."""


class ConcurrentUpdateError(RuntimeError):
    """Raised when another request changed a player during a turn."""


class PlayerRepository:
    """Small repository layer; player documents are keyed by Telegram user ID."""

    def __init__(self, mongodb_uri: str, database_name: str) -> None:
        self._client = AsyncMongoClient(mongodb_uri, serverSelectionTimeoutMS=8000)
        self._database_name = database_name
        self._players: AsyncCollection[dict[str, Any]] | None = None
        self._feedback: AsyncCollection[dict[str, Any]] | None = None

    async def connect(self) -> None:
        """Check MongoDB connectivity and create the indexes used by the game."""
        try:
            await self._client.admin.command("ping")
            database = self._client.get_database(self._database_name)
            self._players = database.get_collection("players")
            self._feedback = database.get_collection("feedback")
            await self._players.create_index("updated_at")
            await self._players.create_index("profile.username")
            await self._feedback.create_index(("user_id", "created_at"))
        except PyMongoError as exc:
            raise DatabaseUnavailable("MongoDB connection failed.") from exc

    async def close(self) -> None:
        await self._client.close()

    async def get_or_create(
        self, *, user_id: int, first_name: str, username: str | None
    ) -> dict[str, Any]:
        players = self._collection()
        document = new_player(user_id=user_id, first_name=first_name, username=username)
        try:
            # Upsert the full document on insert only. We deliberately do NOT combine
            # $setOnInsert with a nested $set on the same path: MongoDB rejects mixes of
            # $setOnInsert (whole "profile") and $set (profile.first_name) with
            # ConflictingUpdateOperators (code 40). The profile is refreshed in a
            # separate, conflict-free operation below.
            result = await players.update_one(
                {"_id": user_id},
                {"$setOnInsert": document},
                upsert=True,
            )
            if result.upserted_id is not None:
                player = await players.find_one({"_id": user_id})
            else:
                player = await players.find_one_and_update(
                    {"_id": user_id},
                    {
                        "$set": {
                            "profile.first_name": document["profile"]["first_name"],
                            "profile.username": document["profile"]["username"],
                            "updated_at": datetime.now(UTC),
                        }
                    },
                    return_document=ReturnDocument.AFTER,
                )
        except DuplicateKeyError:
            # A concurrent request inserted the profile between our lookup and write.
            player = await players.find_one({"_id": user_id})
        except PyMongoError as exc:
            raise DatabaseUnavailable("Could not load the player profile.") from exc
        if not player:
            raise DatabaseUnavailable("MongoDB did not return the player profile.")
        await self._migrate_defaults(player)
        return player

    async def _migrate_defaults(self, player: dict[str, Any]) -> None:
        """Add newer game fields to older documents, persisting them once if changed."""
        game = player["game"]
        before = set(game.keys())
        ensure_game_defaults(player)
        if set(game.keys()) == before:
            return
        try:
            await self._collection().update_one(
                {"_id": player["_id"]},
                {"$set": {"game": player["game"], "updated_at": datetime.now(UTC)}},
            )
        except PyMongoError:
            # Migration is best-effort; the next saved turn will carry the full state.
            return

    async def save_game(self, player: dict[str, Any], *, expected_revision: int) -> dict[str, Any]:
        """Persist game state with optimistic concurrency protection."""
        players = self._collection()
        user_id = player["_id"]
        try:
            result = await players.find_one_and_update(
                {"_id": user_id, "revision": expected_revision},
                {
                    "$set": {
                        "game": player["game"],
                        "updated_at": datetime.now(UTC),
                    },
                    "$inc": {"revision": 1},
                },
                return_document=ReturnDocument.AFTER,
            )
        except PyMongoError as exc:
            raise DatabaseUnavailable("Could not save game progress.") from exc
        if not result:
            raise ConcurrentUpdateError("Player state changed before this turn could be saved.")
        return result

    async def insert_feedback(self, *, user_id: int, first_name: str, kind: str, text: str) -> None:
        """Store one player feedback note (bug report / feature / improvement)."""
        feedback = self._feedback
        if feedback is None:
            raise DatabaseUnavailable("MongoDB has not been initialized.")
        try:
            await feedback.insert_one(
                {
                    "user_id": user_id,
                    "first_name": first_name[:64],
                    "kind": kind if kind in {"bug", "feature", "improve"} else "improve",
                    "text": text[:2000],
                    "created_at": datetime.now(UTC),
                }
            )
        except PyMongoError as exc:
            raise DatabaseUnavailable("Could not store the feedback note.") from exc

    def _collection(self) -> AsyncCollection[dict[str, Any]]:
        if self._players is None:
            raise DatabaseUnavailable("MongoDB has not been initialized.")
        return self._players
