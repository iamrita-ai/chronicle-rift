"""Async MongoDB persistence for player progression."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from pymongo import AsyncMongoClient, ReturnDocument
from pymongo.asynchronous.collection import AsyncCollection
from pymongo.errors import PyMongoError

from .models import new_player


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

    async def connect(self) -> None:
        """Check MongoDB connectivity and create the indexes used by the game."""
        try:
            await self._client.admin.command("ping")
            database = self._client.get_database(self._database_name)
            self._players = database.get_collection("players")
            await self._players.create_index("updated_at")
            await self._players.create_index("profile.username")
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
            player = await players.find_one_and_update(
                {"_id": user_id},
                {
                    "$setOnInsert": document,
                    "$set": {
                        "profile.first_name": document["profile"]["first_name"],
                        "profile.username": document["profile"]["username"],
                        "updated_at": datetime.now(UTC),
                    },
                },
                upsert=True,
                return_document=ReturnDocument.AFTER,
            )
        except PyMongoError as exc:
            raise DatabaseUnavailable("Could not load the player profile.") from exc
        if not player:
            raise DatabaseUnavailable("MongoDB did not return the player profile.")
        return player

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

    def _collection(self) -> AsyncCollection[dict[str, Any]]:
        if self._players is None:
            raise DatabaseUnavailable("MongoDB has not been initialized.")
        return self._players
