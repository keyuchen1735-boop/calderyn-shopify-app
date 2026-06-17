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


from decimal import Decimal

import pytest_asyncio

from calderyn_engine.moat.peer_metrics_etl import run_peer_metrics

PEPPER = "test-pepper-v1"


@pytest_asyncio.fixture(autouse=False)
async def clean_peer_tables(pg_pool):
    """Truncate all tables touched by the run_peer_metrics tests before each
    test that uses it, so prior-test shops/orders don't bleed into counts."""
    async with pg_pool.acquire() as conn:
        await conn.execute(
            "TRUNCATE moat.peer_metric_baselines, "
            "public.order_fact, public.sku_pnl, public.sku_dim, "
            "public.shops RESTART IDENTITY CASCADE"
        )
    yield


async def _seed_shop_in_niche(conn, shop_id, *, consent, category, aov_dollars):
    """Seed a consenting/non-consenting shop with one category and one order so
    its v_peer_kpi_aov value == aov_dollars and its niche == cat:<category>."""
    await _seed_shop(conn, shop_id, consent=consent)
    sku = await _seed_sku(conn, shop_id, category)
    await _seed_pnl(conn, shop_id, sku, day=date.today(), revenue_cents=10_000)
    await conn.execute(
        """
        INSERT INTO public.order_fact
          (id, shop_id, external_id, order_number, created_at_source,
           total_cents, subtotal_cents, source_version)
        VALUES (gen_random_uuid(), $1::uuid, $2, $3, now(),
                $4, $4, (extract(epoch from clock_timestamp())*1000)::bigint)
        """,
        shop_id, f"ord-{uuid.uuid4().hex[:8]}", f"#{uuid.uuid4().hex[:6]}",
        int(aov_dollars * 100),
    )


async def test_below_k_floor_writes_no_row(pg_pool, clean_peer_tables):
    async with pg_pool.acquire() as conn:
        for d in (100, 200):  # only 2 consenting shops < K_FLOOR
            await _seed_shop_in_niche(conn, str(uuid.uuid4()),
                                      consent=True, category="electronics", aov_dollars=d)
        report = await run_peer_metrics(conn, run_date=date.today(), pepper=PEPPER)
        row = await conn.fetchrow(
            "SELECT * FROM moat.peer_metric_baselines "
            "WHERE metric_key='aov' AND segment='cat:electronics'"
        )
    assert row is None
    assert report.metrics_written == 0


async def test_five_consenting_shops_write_quartiles(pg_pool, clean_peer_tables):
    async with pg_pool.acquire() as conn:
        for d in (100, 200, 300, 400, 500):
            await _seed_shop_in_niche(conn, str(uuid.uuid4()),
                                      consent=True, category="electronics", aov_dollars=d)
        await run_peer_metrics(conn, run_date=date.today(), pepper=PEPPER)
        row = await conn.fetchrow(
            "SELECT n, p25, p50, p75 FROM moat.peer_metric_baselines "
            "WHERE metric_key='aov' AND segment='cat:electronics'"
        )
    assert row["n"] == 5
    # percentile_cont over [100,200,300,400,500]
    assert row["p25"] == Decimal("200.000000")
    assert row["p50"] == Decimal("300.000000")
    assert row["p75"] == Decimal("400.000000")


async def test_non_consenting_excluded_from_count(pg_pool, clean_peer_tables):
    async with pg_pool.acquire() as conn:
        for d in (100, 200, 300, 400):  # 4 consenting
            await _seed_shop_in_niche(conn, str(uuid.uuid4()),
                                      consent=True, category="books", aov_dollars=d)
        for d in (500, 600):  # 2 NON-consenting — must not lift count to 6
            await _seed_shop_in_niche(conn, str(uuid.uuid4()),
                                      consent=False, category="books", aov_dollars=d)
        await run_peer_metrics(conn, run_date=date.today(), pepper=PEPPER)
        row = await conn.fetchrow(
            "SELECT * FROM moat.peer_metric_baselines "
            "WHERE metric_key='aov' AND segment='cat:books'"
        )
    assert row is None  # only 4 consenting < K_FLOOR


async def test_delete_stale_when_drops_below_floor(pg_pool, clean_peer_tables):
    seg = "cat:electronics"
    async with pg_pool.acquire() as conn:
        ids = [str(uuid.uuid4()) for _ in range(5)]
        for sid, d in zip(ids, (100, 200, 300, 400, 500)):
            await _seed_shop_in_niche(conn, sid, consent=True,
                                      category="electronics", aov_dollars=d)
        await run_peer_metrics(conn, run_date=date.today(), pepper=PEPPER)
        assert await conn.fetchrow(
            "SELECT 1 FROM moat.peer_metric_baselines "
            "WHERE metric_key='aov' AND segment=$1", seg) is not None
        # Two shops withdraw → 3 left < K_FLOOR → row must be deleted.
        await conn.execute(
            "UPDATE public.shops SET peer_data_consent=false WHERE id = ANY($1::uuid[])",
            ids[:2],
        )
        report = await run_peer_metrics(conn, run_date=date.today(), pepper=PEPPER)
        gone = await conn.fetchrow(
            "SELECT 1 FROM moat.peer_metric_baselines "
            "WHERE metric_key='aov' AND segment=$1", seg)
    assert gone is None
    assert report.segments_deleted >= 1
