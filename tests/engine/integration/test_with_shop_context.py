# apps/engine/tests/integration/test_with_shop_context.py
"""Plan 03 Task 3: with_shop_context binds and unbinds the shop GUC."""
from __future__ import annotations

import pytest

from calderyn_engine.db import with_shop_context


@pytest.mark.asyncio
async def test_with_shop_context_sets_current_shop_id(pg_pool):
    shop_id = "00000000-0000-0000-0000-000000000001"
    async with pg_pool.acquire() as conn:
        async with with_shop_context(conn, shop_id):
            row = await conn.fetchrow("SELECT current_shop_id() AS id")
            assert str(row["id"]) == shop_id


@pytest.mark.asyncio
async def test_with_shop_context_unsets_after_exit(pg_pool):
    shop_id = "00000000-0000-0000-0000-000000000002"
    async with pg_pool.acquire() as conn:
        async with with_shop_context(conn, shop_id):
            pass
        row = await conn.fetchrow(
            "SELECT current_setting('app.shop_id', true) AS s"
        )
        assert row["s"] in (None, "", "00000000-0000-0000-0000-000000000000")
