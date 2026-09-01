"""Non-secret defaults needed only when importing the deployable ASGI module in tests."""

from __future__ import annotations

import os

os.environ.setdefault("BOT_TOKEN", "123456:unit-test-bot-token")
os.environ.setdefault("MONGODB_URI", "mongodb://localhost:27017")
os.environ.setdefault("GROQ_API_KEY", "unit-test-groq-key")
os.environ.setdefault("BOT_MODE", "polling")
