"""Plan 03 Task 20: RLS guard — engine cannot cross shop boundary.

Two assertions:

1. After running the pipeline for shop A only, opening a connection
   scoped to shop A's GUC sees A's alerts; the same data is invisible to
   any reader scoped to shop B.
2. Under the ``authenticated`` role with no shop GUC bound, every alert
   row is invisible — RLS evaluates ``current_shop_id()`` to NULL, the
   policy ``shop_id = current_shop_id()`` is false, and zero rows are
   returned.

The second assertion exercises the same RLS surface a Remix loader sees
when a session has not yet bound the shop context — a regression there
would silently leak rows across tenants.
"""

from __future__ import annotations

import os
from datetime import date
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import AsyncMock

import asyncpg
import pytest

from calderyn_engine.config import Config
from calderyn_engine.db import with_shop_context
from calderyn_engine.pipeline import run_for_shop

# Distinct from other test files' SHOP ids — each test module owns a
# slot in the trailing byte so accidental shop-row collisions don't
# leak rows across modules.
SHOP_A = "00000000-0000-0000-0000-00000000000a"
SHOP_B = "00000000-0000-0000-0000-00000000000b"


def _cfg() -> Config:
    url = os.environ.get("TEST_DATABASE_URL") or os.environ.get(
        "DATABASE_URL", ""
    )
    return Config(
        database_url=url,
        anthropic_api_key="test-key",
        env="test",
        claude_model="claude-opus-4-7",
    )


def _mock_client() -> SimpleNamespace:
    block = SimpleNamespace(type="text", text='{"ranked":[]}')
    response = SimpleNamespace(content=[block])
    messages = SimpleNamespace(create=AsyncMock(return_value=response))
    return SimpleNamespace(messages=messages)


@pytest.mark.asyncio
async def test_pipeline_for_shop_a_does_not_leak_to_shop_b(
    pg_pool: asyncpg.Pool,
    seed_shop,
    seed_stockout_scenario,
) -> None:
    """Run for A only → A's GUC sees rows, B's GUC sees none of them."""
    # Clear any alert rows left over from prior tests in the same CI run
    # (e.g. test_pipeline_end_to_end uses a different SHOP id but its
    # alerts persist in the alerts/alert_context tables and would leak
    # into this test's "all visible rows belong to SHOP_A" assertion
    # because they belong to neither SHOP_A nor SHOP_B). Done as a raw
    # DELETE under the postgres superuser (the test connection role)
    # which bypasses RLS, so we can wipe the table cleanly.
    async with pg_pool.acquire() as conn:
        await conn.execute("DELETE FROM public.alert_context")
        await conn.execute("DELETE FROM public.alerts")

    await seed_shop(SHOP_A)
    await seed_shop(SHOP_B)
    # Seed B first, then A — seed_stockout_scenario uses fixed dimension
    # UUIDs and re-seeds delete prior rows on those UUIDs, so the LAST
    # call wins. A is the shop the pipeline runs for, so it must be
    # seeded last to leave its data in place.
    await seed_stockout_scenario(
        SHOP_B,
        spend_usd=Decimal("900"),
        stock_on_hand=0,
        velocity=Decimal("8"),
        unit_margin=Decimal("30"),
    )
    await seed_stockout_scenario(
        SHOP_A,
        spend_usd=Decimal("900"),
        stock_on_hand=0,
        velocity=Decimal("8"),
        unit_margin=Decimal("30"),
    )

    upserted = await run_for_shop(
        SHOP_A,
        day=date(2026, 4, 19),
        cfg=_cfg(),
        claude_client=_mock_client(),
        pool=pg_pool,
    )
    assert len(upserted) >= 1

    # Switch to the `authenticated` role so RLS policies actually filter
    # rows. The default test connection runs as `postgres` (superuser)
    # which bypasses RLS, making the leak assertions meaningless.
    # GRANT SELECT is idempotent and required because vanilla Postgres
    # CI lacks the Supabase init grants the harness skips for testcontainers.
    async with pg_pool.acquire() as conn:
        await conn.execute(
            "GRANT SELECT ON public.alerts TO authenticated"
        )
        async with with_shop_context(conn, SHOP_A):
            await conn.execute("SET LOCAL ROLE authenticated")
            a_visible = await conn.fetch(
                "SELECT shop_id FROM public.alerts"
            )
        async with with_shop_context(conn, SHOP_B):
            await conn.execute("SET LOCAL ROLE authenticated")
            b_visible = await conn.fetch(
                "SELECT shop_id FROM public.alerts"
            )

    # Under shop A's GUC + authenticated role, every visible row is shop A.
    assert a_visible, "expected at least one alert visible under SHOP_A GUC"
    assert all(str(r["shop_id"]) == SHOP_A for r in a_visible)
    # Under shop B's GUC + authenticated role, RLS should hide shop A's rows.
    assert all(str(r["shop_id"]) != SHOP_A for r in b_visible)


@pytest.mark.asyncio
async def test_authenticated_role_with_no_guc_sees_zero_rows(
    pg_pool: asyncpg.Pool,
    seed_shop,
    seed_stockout_scenario,
) -> None:
    """``SET ROLE authenticated`` + no shop GUC → RLS hides every alert.

    The migration's RLS policy compares against ``current_shop_id()``,
    which returns NULL when ``app.shop_id`` is unset. NULL comparisons in
    a policy yield NULL (treated as false), so every row is filtered out.
    """
    await seed_shop(SHOP_A)
    await seed_stockout_scenario(
        SHOP_A,
        spend_usd=Decimal("900"),
        stock_on_hand=0,
        velocity=Decimal("8"),
        unit_margin=Decimal("30"),
    )
    await run_for_shop(
        SHOP_A,
        day=date(2026, 4, 19),
        cfg=_cfg(),
        claude_client=_mock_client(),
        pool=pg_pool,
    )

    async with pg_pool.acquire() as conn:
        # Confirm the row was actually inserted (under the elevated test
        # role which bypasses RLS via service_role-equivalent privileges).
        baseline = await conn.fetchval(
            "SELECT count(*) FROM alerts WHERE shop_id = $1::uuid", SHOP_A
        )
        assert baseline >= 1

        # Vanilla Postgres lacks the default Supabase-init grants that
        # let `authenticated` even SELECT public tables — without this,
        # `SET ROLE authenticated` would fail at the ACL check before
        # RLS evaluates. Grant the bare-minimum privilege so the test
        # exercises RLS, not ACL. Idempotent and scoped to this test.
        await conn.execute("GRANT USAGE ON SCHEMA public TO authenticated")
        await conn.execute(
            "GRANT SELECT ON public.alerts TO authenticated"
        )

        # Switch to the authenticated role and try again. With no GUC
        # bound, RLS yields zero rows. We do NOT call set_config here,
        # so app.shop_id is empty/NULL.
        await conn.execute("SET ROLE authenticated")
        try:
            visible = await conn.fetch(
                "SELECT id FROM alerts WHERE shop_id = $1::uuid", SHOP_A
            )
            assert visible == []
        finally:
            await conn.execute("RESET ROLE")
