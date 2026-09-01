"""Local development entry point: ``python -m chronicle_rift``."""

from __future__ import annotations

import uvicorn

from .config import Settings


def main() -> None:
    """Run the FastAPI host using the configured local port."""
    settings = Settings.from_env()
    uvicorn.run("chronicle_rift.main:app", host="0.0.0.0", port=settings.port, reload=False)


if __name__ == "__main__":
    main()
