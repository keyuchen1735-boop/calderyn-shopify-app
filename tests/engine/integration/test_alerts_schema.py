# apps/engine/tests/integration/test_alerts_schema.py
"""Plan 03 Task 1: schema-level checks for the alerts table family."""
from __future__ import annotations

import pytest


@pytest.mark.asyncio
async def test_alerts_table_exists_with_expected_columns(pg_pool):
    async with pg_pool.acquire() as conn:
        cols = await conn.fetch(
            """
            SELECT column_name FROM information_schema.columns
            WHERE table_name = 'alerts' ORDER BY column_name
            """
        )
        names = {r["column_name"] for r in cols}
    assert {
        "id",
        "shop_id",
        "detector_id",
        "entity_ref",
        "status",
        "severity",
        "dollar_impact",
        "day_bucket",
        "claude_narrative",
        "claude_rank",
        "first_seen_at",
        "last_seen_at",
        "resolved_at",
    }.issubset(names)


@pytest.mark.asyncio
async def test_alerts_has_rls_enabled(pg_pool):
    async with pg_pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT relrowsecurity FROM pg_class WHERE relname = 'alerts'"
        )
    assert row["relrowsecurity"] is True
