"""Cross-tenant isolation for the calibration tables/functions.

Mirrors test_rls_guard.py exactly (asyncpg pool, with_shop_context,
SET LOCAL ROLE authenticated pattern).

Assertions:
  1. shop A bound via set_config('app.shop_id', ...) sees only its own
     pair_calibration rows; shop B sees none of A's rows.
  2. An authenticated session with NO shop GUC bound sees zero rows from
     pair_calibration (NULL = NULL in the policy is false → deny all).
  3. anon/authenticated cannot EXECUTE action_pair_prior (EXECUTE revoked;
     Postgres raises permission denied).
"""

from __future__ import annotations

import asyncpg
import pytest

from calderyn_engine.db import with_shop_context

# Distinct trailing bytes so UUIDs cannot collide with other test modules.
SHOP_A = "00000000-0000-0000-0000-0000000000ca"
SHOP_B = "00000000-0000-0000-0000-0000000000cb"


async def _seed_shop(conn: asyncpg.Connection, shop_id: str) -> None:
    suffix = shop_id.replace("-", "")[-12:]
    await conn.execute(
        "INSERT INTO public.shops (id, shop_domain) VALUES ($1, $2)"
        " ON CONFLICT (id) DO NOTHING",
        shop_id,
        f"test-cal-{suffix}.myshopify.com",
    )


async def _seed_pair(conn: asyncpg.Connection, shop_id: str) -> None:
    """Insert one pair_calibration row as the superuser (bypasses RLS)."""
    await conn.execute(
        """
        INSERT INTO public.pair_calibration
          (shop_id, detector_id, action_kind, alpha, beta)
        VALUES ($1, 'sku_stockout_vs_spend', 'pause_campaign', 1, 0)
        ON CONFLICT (shop_id, detector_id, action_kind) DO NOTHING
        """,
        shop_id,
    )


@pytest.mark.asyncio
async def test_pair_calibration_is_shop_scoped(
    pg_pool: asyncpg.Pool,
) -> None:
    """Shop A bound via GUC sees only its own row; B's GUC sees none of A's."""
    async with pg_pool.acquire() as conn:
        await _seed_shop(conn, SHOP_A)
        await _seed_shop(conn, SHOP_B)
        await _seed_pair(conn, SHOP_A)
        await _seed_pair(conn, SHOP_B)

        # Grant SELECT so `authenticated` can reach the ACL layer (the real
        # Supabase init grants are absent from the vanilla Postgres test DB).
        await conn.execute(
            "GRANT SELECT ON public.pair_calibration TO authenticated"
        )
        await conn.execute(
            "GRANT USAGE ON SCHEMA public TO authenticated"
        )

        # Shop A's GUC: should see exactly A's row.
        async with with_shop_context(conn, SHOP_A):
            await conn.execute("SET LOCAL ROLE authenticated")
            a_rows = await conn.fetch(
                "SELECT shop_id FROM public.pair_calibration"
            )

        # Shop B's GUC: should see zero of A's rows (only B's if any).
        async with with_shop_context(conn, SHOP_B):
            await conn.execute("SET LOCAL ROLE authenticated")
            b_rows = await conn.fetch(
                "SELECT shop_id FROM public.pair_calibration"
            )

    assert a_rows, "shop A should see its own pair_calibration row"
    assert all(str(r["shop_id"]) == SHOP_A for r in a_rows), (
        "shop A must not see shop B's rows"
    )
    assert all(str(r["shop_id"]) != SHOP_A for r in b_rows), (
        "shop B must not see shop A's rows"
    )


@pytest.mark.asyncio
async def test_unbound_session_sees_nothing(
    pg_pool: asyncpg.Pool,
) -> None:
    """authenticated role + no GUC bound -> RLS hides every pair_calibration row."""
    async with pg_pool.acquire() as conn:
        await _seed_shop(conn, SHOP_A)
        await _seed_pair(conn, SHOP_A)

        # Confirm superuser baseline: the row exists.
        baseline = await conn.fetchval(
            "SELECT count(*) FROM public.pair_calibration WHERE shop_id = $1::uuid",
            SHOP_A,
        )
        assert baseline >= 1, "seeded row must be visible under superuser"

        await conn.execute(
            "GRANT USAGE ON SCHEMA public TO authenticated"
        )
        await conn.execute(
            "GRANT SELECT ON public.pair_calibration TO authenticated"
        )

        # Switch to authenticated with no GUC -> current_shop_id() is NULL.
        await conn.execute("SET ROLE authenticated")
        try:
            visible = await conn.fetch(
                "SELECT shop_id FROM public.pair_calibration"
            )
            assert visible == [], (
                "unbound authenticated session must see zero pair_calibration rows"
            )
        finally:
            await conn.execute("RESET ROLE")


@pytest.mark.asyncio
async def test_action_pair_prior_not_callable_by_authenticated(
    pg_pool: asyncpg.Pool,
) -> None:
    """authenticated role cannot EXECUTE action_pair_prior (EXECUTE revoked)."""
    async with pg_pool.acquire() as conn:
        await conn.execute("GRANT USAGE ON SCHEMA public TO authenticated")

        await conn.execute("SET ROLE authenticated")
        try:
            with pytest.raises(
                asyncpg.InsufficientPrivilegeError,
                match="permission denied",
            ):
                await conn.fetchval(
                    "SELECT public.action_pair_prior($1, 'sku_stockout_vs_spend',"
                    " 'pause_campaign')",
                    "00000000-0000-0000-0000-000000000001",
                )
        finally:
            await conn.execute("RESET ROLE")
