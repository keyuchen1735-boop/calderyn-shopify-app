"""DB-backed tests for peer_metrics_etl. Skip unless a local TEST_DATABASE_URL
is set (inherits pg_pool + cleanup from the parent conftest)."""
from __future__ import annotations

import uuid
from datetime import date

import pytest

from calderyn_engine.moat.peer_metrics_etl import category_niche_for_shop

pytestmark = pytest.mark.asyncio

RUN_DATE = date(2026, 6, 17)


async def _seed_shop(conn, shop_id: str, *, consent: bool = True) -> None:
    suffix = shop_id.replace("-", "")[-12:]
    await conn.execute(
        "INSERT INTO public.shops (id, shop_domain, peer_data_consent) "
        "VALUES ($1::uuid, $2, $3) "
        "ON CONFLICT (id) DO UPDATE SET peer_data_consent = EXCLUDED.peer_data_consent",
        shop_id, f"pm-{suffix}.myshopify.com", consent,
    )


async def _seed_sku(conn, shop_id: str, category: str | None) -> str:
    sku_id = str(uuid.uuid4())
    await conn.execute(
        "INSERT INTO public.sku_dim (id, shop_id, external_id, product_id, title, category) "
        "VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)",
        sku_id, shop_id, f"ext-{sku_id[:8]}", f"prod-{sku_id[:8]}", "Item", category,
    )
    return sku_id


async def _seed_pnl(conn, shop_id: str, sku_id: str, *, day: date, revenue_cents: int) -> None:
    await conn.execute(
        "INSERT INTO public.sku_pnl "
        "(shop_id, sku_id, day, revenue_cents, cogs_cents, ad_spend_attrib_cents, "
        " contribution_margin_cents) "
        "VALUES ($1::uuid, $2::uuid, $3, $4, 0, 0, $4) "
        "ON CONFLICT (sku_id, day) DO UPDATE SET revenue_cents = EXCLUDED.revenue_cents",
        shop_id, sku_id, day, revenue_cents,
    )


async def test_dominant_category_wins(pg_pool):
    shop_id = str(uuid.uuid4())
    async with pg_pool.acquire() as conn:
        await _seed_shop(conn, shop_id)
        elec = await _seed_sku(conn, shop_id, "electronics")
        appa = await _seed_sku(conn, shop_id, "apparel")
        await _seed_pnl(conn, shop_id, elec, day=date(2026, 6, 1), revenue_cents=10_000)
        await _seed_pnl(conn, shop_id, appa, day=date(2026, 6, 1), revenue_cents=4_000)
        niche = await category_niche_for_shop(conn, shop_id, RUN_DATE)
    assert niche == "cat:electronics"


async def test_tie_breaks_alphabetically(pg_pool):
    shop_id = str(uuid.uuid4())
    async with pg_pool.acquire() as conn:
        await _seed_shop(conn, shop_id)
        a = await _seed_sku(conn, shop_id, "apparel")
        b = await _seed_sku(conn, shop_id, "books")
        await _seed_pnl(conn, shop_id, a, day=date(2026, 6, 1), revenue_cents=5_000)
        await _seed_pnl(conn, shop_id, b, day=date(2026, 6, 1), revenue_cents=5_000)
        niche = await category_niche_for_shop(conn, shop_id, RUN_DATE)
    assert niche == "cat:apparel"  # tie → alphabetical


async def test_no_sales_is_uncategorized(pg_pool):
    shop_id = str(uuid.uuid4())
    async with pg_pool.acquire() as conn:
        await _seed_shop(conn, shop_id)
        niche = await category_niche_for_shop(conn, shop_id, RUN_DATE)
    assert niche == "cat:uncategorized"


async def test_outside_90d_window_excluded(pg_pool):
    shop_id = str(uuid.uuid4())
    async with pg_pool.acquire() as conn:
        await _seed_shop(conn, shop_id)
        sku = await _seed_sku(conn, shop_id, "electronics")
        await _seed_pnl(conn, shop_id, sku, day=date(2026, 1, 1), revenue_cents=99_000)  # >90d
        niche = await category_niche_for_shop(conn, shop_id, RUN_DATE)
    assert niche == "cat:uncategorized"


async def test_resolver_matches_niche_view_for_today(pg_pool):
    """The Python resolver (run_date) and v_peer_shop_niche (current_date) are
    documented mirrors — pin them equal when run_date == today."""
    shop_id = str(uuid.uuid4())
    async with pg_pool.acquire() as conn:
        await _seed_shop(conn, shop_id)
        sku = await _seed_sku(conn, shop_id, "electronics")
        await _seed_pnl(conn, shop_id, sku, day=date.today(), revenue_cents=10_000)
        resolved = await category_niche_for_shop(conn, shop_id, date.today())
        row = await conn.fetchrow(
            "SELECT segment FROM public.v_peer_shop_niche WHERE shop_id = $1::uuid",
            shop_id,
        )
    assert resolved == "cat:electronics"
    assert row is not None and row["segment"] == resolved
