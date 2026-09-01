"""Authenticated Telegram identity primitives shared by bot and Mini App routes."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class TelegramIdentity:
    """Minimal, verified identity used to read or change a player's state."""

    user_id: int
    first_name: str
    username: str | None = None

    def __post_init__(self) -> None:
        if self.user_id <= 0:
            raise ValueError("Telegram user IDs must be positive.")
