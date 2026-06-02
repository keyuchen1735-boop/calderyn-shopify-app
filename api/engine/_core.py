"""Transport-agnostic core for the engine Vercel function.

Kept separate from run.py so the auth gate + pipeline invocation are unit
testable without spinning up an HTTP server. The handler in run.py is a
thin adapter over handle().
"""
from __future__ import annotations

import os
import sys
from typing import Any

# Ensure the vendored package (sibling dir) is importable when Vercel loads
# this file as a standalone function.
sys.path.insert(0, os.path.dirname(__file__))

from calderyn_engine.config import load_config  # noqa: E402
from calderyn_engine.db import make_pool  # noqa: E402
from calderyn_engine.pipeline import run_for_shop  # noqa: E402


def _authorized(authorization: str | None) -> bool:
    secret = os.environ.get("CRON_SECRET")
    return bool(secret) and authorization == f"Bearer {secret}"


async def handle(
    body: dict[str, Any], authorization: str | None
) -> tuple[int, dict[str, Any]]:
    """Run the detector pipeline for one shop. Returns (status, json-body)."""
    if not _authorized(authorization):
        return 401, {"error": "unauthorized"}

    shop_id = (body or {}).get("shop_id")
    if not shop_id or not isinstance(shop_id, str):
        return 400, {"error": "shop_id is required"}

    cfg = load_config()
    # Fresh pool per invocation: asyncpg pools bind to the event loop, and a
    # serverless invocation gets a fresh loop, so a cached cross-loop pool
    # would error. Short-lived pool, closed in finally.
    pool = await make_pool(cfg.database_url, max_size=4)
    try:
        ids = await run_for_shop(shop_id, cfg=cfg, pool=pool)
    finally:
        await pool.close()
    return 200, {"shop_id": shop_id, "alert_ids": ids}
