from __future__ import annotations

import os
import sys

# Make the repo-root engine/ dir importable so `import _core` (and its sibling
# `calderyn_engine`) resolves the same way the Vercel function does. Must run at
# conftest import time, before any test imports the engine package.
_HERE = os.path.dirname(__file__)
_ENGINE_DIR = os.path.abspath(os.path.join(_HERE, "..", "..", "engine"))
if _ENGINE_DIR not in sys.path:
    sys.path.insert(0, _ENGINE_DIR)

# apps/engine/tests/conftest.py
"""Shared async fixtures for the engine tests.

Plan 03 Tasks 2 + 5: pg_pool from TEST_DATABASE_URL/DATABASE_URL and a
seed_shop helper that inserts into public.shops using the real shop_domain
column.

Plan 03 Tasks 10–13 (this file): per-detector scenario fixtures that seed
the minimum Plan 02 rows needed to exercise each detector. Each fixture
uses the REAL Plan 02 column names (cents, observed_at, window_days,
platform, source) — Plan 03's detector SQL examples reference column
names from a hypothetical schema and must be translated.
"""

import asyncio
import itertools
import os
from datetime import datetime, timedelta, UTC
from decimal import Decimal

import asyncpg
import pytest
import pytest_asyncio


def _local_test_db_url() -> str | None:
    """Return the engine test DB URL, but ONLY if it is an explicit,
    local test database.

    SAFETY: the engine's ``calderyn_engine.config`` calls ``load_dotenv()`` at
    import, which populates ``DATABASE_URL`` from .env/.env.local with the
    SHARED Supabase URL — even when the shell has it unset. The DB tests (and
    especially the truncation fixture below) must never touch that. So we read
    ONLY ``TEST_DATABASE_URL`` (never ``DATABASE_URL``) and additionally refuse
    any host that is not localhost/127.0.0.1. This makes it impossible for the
    suite to read from or write to a remote database.

    Note: asyncpg also honours a ``?host=``/``?hostaddr=`` query parameter that
    OVERRIDES the netloc host, so we must validate those too — checking only
    ``urlparse().hostname`` would let ``postgres://localhost/db?host=remote``
    slip through. Every specified host must be loopback, and at least one host
    must be specified (a bare ``postgres:///db`` unix-socket form is rejected).
    """
    url = os.environ.get("TEST_DATABASE_URL")
    if not url:
        return None
    from urllib.parse import parse_qs, urlparse

    parsed = urlparse(url)
    qs = parse_qs(parsed.query)
    hosts = [
        h.lower()
        for h in ([parsed.hostname] if parsed.hostname else [])
        + qs.get("host", [])
        + qs.get("hostaddr", [])
        if h
    ]
    allowed = {"localhost", "127.0.0.1", "::1"}
    if not hosts or any(h not in allowed for h in hosts):
        raise RuntimeError(
            f"TEST_DATABASE_URL hosts {hosts!r} are not all local. The engine "
            "test suite refuses to run against a non-loopback database to avoid "
            "mutating shared data. Use tests/engine/scripts/test-db.sh."
        )
    return url


async def _truncate_engine_data(url: str) -> None:
    """TRUNCATE every base table in the engine schemas."""
    conn = await asyncpg.connect(url)
    try:
        rows = await conn.fetch(
            """
            SELECT format('%I.%I', schemaname, tablename) AS qname
            FROM pg_tables
            WHERE schemaname IN ('public', 'moat', 'moat_keys')
            """
        )
        if rows:
            qnames = ", ".join(r["qname"] for r in rows)
            await conn.execute(f"TRUNCATE {qnames} RESTART IDENTITY CASCADE")
    finally:
        await conn.close()


@pytest.fixture(scope="session", autouse=True)
def _clean_engine_db():
    """Start each DB-backed session from empty data tables.

    The ported monorepo tests assume a pristine database per run — the CI
    postgres service is fresh every time. The local docker test DB persists
    between runs, so without this a re-run would see rows left by the few
    tests that don't self-clean (e.g. the alert_thresholds / moat overrides
    in test_thresholds.py) and fail. Truncating up front makes every run
    hermetic regardless of how the DB was provisioned. No-op when no DB is
    configured — the DB-backed tests skip in that case anyway.
    """
    url = _local_test_db_url()
    if url:
        asyncio.run(_truncate_engine_data(url))
    yield


# Monotonic counter for source_version values. extract(epoch from now()) only
# resolves to seconds, so successive tests within the same second hit
# inventory_level_fact's unique(sku_id, location_id, source_version) constraint
# even though each test uses a fresh row. We bump a process-wide counter so
# every fixture insert gets a guaranteed-unique bigint.
_SOURCE_VERSION_SEQ = itertools.count(1)


def _next_source_version() -> int:
    """Return a strictly increasing bigint for source_version columns."""

    # Combine wall-clock ms with a per-process counter so values are unique
    # across both rapid same-second test execution and across CI re-runs.
    return int(datetime.now(UTC).timestamp() * 1000) + next(_SOURCE_VERSION_SEQ)


@pytest_asyncio.fixture
async def pg_pool():
    url = _local_test_db_url()
    if not url:
        pytest.skip("TEST_DATABASE_URL not set to a local test database")
    pool = await asyncpg.create_pool(url, min_size=1, max_size=4)
    try:
        yield pool
    finally:
        await pool.close()


@pytest.fixture
def seed_shop(pg_pool):
    """Insert a shop row keyed by id with a deterministic shop_domain.

    Returns a coroutine factory the test can `await` so multiple shops can be
    seeded in a single test if needed.
    """

    async def _seed(shop_id: str) -> None:
        # All detector-test shop_ids share the prefix 00000000-0000-...; use the
        # last 12 hex chars which are unique per scenario. shop_domain has its
        # own UNIQUE constraint, so the first 8 chars would collide across
        # tests. ON CONFLICT (id) handles intra-test re-seeding; the per-test
        # uniqueness of shop_domain handles cross-test inserts.
        suffix = shop_id.replace("-", "")[-12:]
        async with pg_pool.acquire() as conn:
            await conn.execute(
                "INSERT INTO shops (id, shop_domain) VALUES ($1, $2) "
                "ON CONFLICT (id) DO NOTHING",
                shop_id,
                f"test-{suffix}.myshopify.com",
            )

    return _seed


# ---------------------------------------------------------------------------
# Detector scenario fixtures (Plan 03 Tasks 10–13)
#
# Each fixture cleans the rows it seeds before inserting so multiple tests
# in a session don't accumulate stale data. They use service-role implicit
# privileges (the test DB role) which bypass RLS for inserts.
# ---------------------------------------------------------------------------


def _cents(d: Decimal) -> int:
    """Convert a Decimal-USD value to integer cents."""

    return int((d * Decimal("100")).quantize(Decimal("1")))


@pytest.fixture
def seed_stockout_scenario(pg_pool):
    """Plan 03 Task 10: SKU stocked out, ad spend still flowing.

    Inserts a single SKU + location + campaign + creative→sku map +
    spend row + velocity row + 7-day P&L slice. Used by
    ``test_detector_sku_stockout_vs_spend.py``.
    """

    sku_id = "11111111-1111-1111-1111-111111111111"
    location_id = "11111111-1111-1111-1111-111111111aaa"
    campaign_id = "22222222-2222-2222-2222-222222222222"

    async def _seed(
        shop_id: str,
        *,
        spend_usd: Decimal,
        stock_on_hand: int,
        velocity: Decimal,
        unit_margin: Decimal,
    ) -> None:
        async with pg_pool.acquire() as conn:
            # Clean up rows from prior tests that may have used these fixed
            # UUIDs under a different shop_id; otherwise RLS hides them
            # from the current test's shop and the detector returns empty.
            await conn.execute(
                "DELETE FROM public.ad_spend_fact WHERE campaign_id = $1",
                campaign_id,
            )
            await conn.execute(
                "DELETE FROM public.ad_creative_sku_map WHERE sku_id = $1",
                sku_id,
            )
            await conn.execute(
                "DELETE FROM public.ad_campaign_dim WHERE id = $1",
                campaign_id,
            )
            await conn.execute(
                "DELETE FROM public.sku_pnl WHERE sku_id = $1",
                sku_id,
            )
            await conn.execute(
                "DELETE FROM public.sku_velocity WHERE sku_id = $1",
                sku_id,
            )
            await conn.execute(
                "DELETE FROM public.inventory_level_fact "
                "WHERE sku_id = $1 OR location_id = $2",
                sku_id,
                location_id,
            )
            await conn.execute(
                "DELETE FROM public.location_dim WHERE id = $1",
                location_id,
            )
            await conn.execute(
                "DELETE FROM public.sku_dim WHERE id = $1",
                sku_id,
            )
            # SKU dimension. ``unit_cost_cents`` is the SCD2-latest snapshot.
            await conn.execute(
                """
                INSERT INTO public.sku_dim
                  (id, shop_id, external_id, product_id, sku, title,
                   unit_cost_cents, currency)
                VALUES ($1, $2, 'ext-test-1', 'prod-1', 'TEST-1',
                        'Test SKU', 1000, 'USD')
                """,
                sku_id,
                shop_id,
            )
            # Location dimension.
            await conn.execute(
                """
                INSERT INTO public.location_dim
                  (id, shop_id, external_id, name, country, region, active)
                VALUES ($1, $2, 'loc-1', 'Main Warehouse', 'US', 'CA', true)
                """,
                location_id,
                shop_id,
            )
            # Inventory snapshot — observed_at is the real column name
            # (Plan 03 calls it 'as_of').
            await conn.execute(
                """
                INSERT INTO public.inventory_level_fact
                  (shop_id, sku_id, location_id, available, observed_at,
                   source_version)
                VALUES ($1, $2, $3, $4, now(), $5)
                """,
                shop_id,
                sku_id,
                location_id,
                stock_on_hand,
                _next_source_version(),
            )
            # Velocity — the 1-day window is the daily figure.
            await conn.execute(
                """
                INSERT INTO public.sku_velocity
                  (shop_id, sku_id, location_id, window_days, units, computed_at)
                VALUES ($1, $2, NULL, 1, $3, now())
                """,
                shop_id,
                sku_id,
                velocity,
            )
            # Per-day P&L row encoding the unit margin: revenue =
            # unit_margin * velocity, cogs = 0 makes contribution_margin
            # = unit_margin * velocity per day, summed over 7 days
            # ⇒ unit_margin reproducible at the detector's computation.
            margin_cents_per_day = _cents(unit_margin * velocity)
            for day_offset in range(7):
                await conn.execute(
                    """
                    INSERT INTO public.sku_pnl
                      (shop_id, sku_id, day, revenue_cents, cogs_cents,
                       ad_spend_attrib_cents, return_cents,
                       contribution_margin_cents)
                    VALUES ($1, $2, current_date - $3::int,
                            $4, 0, 0, 0, $4)
                    ON CONFLICT (sku_id, day) DO UPDATE SET
                      contribution_margin_cents = EXCLUDED.contribution_margin_cents,
                      revenue_cents = EXCLUDED.revenue_cents
                    """,
                    shop_id,
                    sku_id,
                    day_offset,
                    margin_cents_per_day,
                )
            # Campaign + creative→sku map (merchant_confirmed) + spend.
            await conn.execute(
                """
                INSERT INTO public.ad_campaign_dim
                  (id, shop_id, platform, external_id, name, status, currency)
                VALUES ($1, $2, 'meta', 'cmp_test_1', 'Test Campaign',
                        'active', 'USD')
                """,
                campaign_id,
                shop_id,
            )
            await conn.execute(
                """
                INSERT INTO public.ad_creative_sku_map
                  (shop_id, platform, creative_id, creative_label, sku_id,
                   confidence, source, confirmed_at)
                VALUES ($1, 'meta', 'creative_1', 'Creative One', $2,
                        0.95, 'merchant_confirmed', now())
                """,
                shop_id,
                sku_id,
            )
            await conn.execute(
                """
                INSERT INTO public.ad_spend_fact
                  (shop_id, campaign_id, day, spend_cents)
                VALUES ($1, $2, current_date, $3)
                """,
                shop_id,
                campaign_id,
                _cents(spend_usd),
            )

    return _seed


@pytest.fixture
def seed_breakeven_scenario(pg_pool):
    """Plan 03 Task 11: campaign whose 7-day spend > attributed gross profit.

    COGS in Plan 02 is *derived* from order_line_fact.unit_cost_cents_snapshot;
    we therefore seed an order, an order line carrying the COGS snapshot,
    and an attribution_fact row pinning revenue to the campaign.
    """

    sku_id = "33333333-3333-3333-3333-3333333333aa"
    campaign_id = "33333333-3333-3333-3333-333333333333"
    order_id = "33333333-3333-3333-3333-3333333333bb"

    async def _seed(
        shop_id: str,
        *,
        spend: Decimal,
        revenue: Decimal,
        cogs: Decimal,
    ) -> None:
        async with pg_pool.acquire() as conn:
            # Clean up state from prior tests that may have used these
            # fixed UUIDs under a different shop_id.
            await conn.execute(
                "DELETE FROM public.attribution_fact WHERE order_id = $1",
                order_id,
            )
            await conn.execute(
                "DELETE FROM public.order_line_fact WHERE order_id = $1",
                order_id,
            )
            await conn.execute(
                "DELETE FROM public.order_fact WHERE id = $1",
                order_id,
            )
            await conn.execute(
                "DELETE FROM public.ad_spend_fact WHERE campaign_id = $1",
                campaign_id,
            )
            await conn.execute(
                "DELETE FROM public.ad_campaign_dim WHERE id = $1",
                campaign_id,
            )
            await conn.execute(
                "DELETE FROM public.sku_dim WHERE id = $1",
                sku_id,
            )
            await conn.execute(
                """
                INSERT INTO public.sku_dim
                  (id, shop_id, external_id, product_id, sku, title,
                   unit_cost_cents, currency)
                VALUES ($1, $2, 'ext-be-1', 'prod-be-1', 'BE-1',
                        'Breakeven SKU', $3, 'USD')
                """,
                sku_id,
                shop_id,
                _cents(cogs),
            )
            await conn.execute(
                """
                INSERT INTO public.ad_campaign_dim
                  (id, shop_id, platform, external_id, name, status, currency)
                VALUES ($1, $2, 'meta', 'cmp_be', 'Breakeven Campaign',
                        'active', 'USD')
                """,
                campaign_id,
                shop_id,
            )
            await conn.execute(
                """
                INSERT INTO public.ad_spend_fact
                  (shop_id, campaign_id, day, spend_cents)
                VALUES ($1, $2, current_date, $3)
                """,
                shop_id,
                campaign_id,
                _cents(spend),
            )
            # An attributed order from "today" so it falls inside the
            # detector's trailing-7-day window.
            await conn.execute(
                """
                INSERT INTO public.order_fact
                  (id, shop_id, external_id, order_number,
                   created_at_source, total_cents, subtotal_cents,
                   source_version)
                VALUES ($1, $2, 'ord_be_1', '#1001', now(),
                        $3, $3, $4)
                """,
                order_id,
                shop_id,
                _cents(revenue),
                _next_source_version(),
            )
            # Single order line: quantity 1, unit_cost_snapshot = total cogs.
            await conn.execute(
                """
                INSERT INTO public.order_line_fact
                  (shop_id, order_id, sku_id, external_line_id,
                   quantity, price_cents, total_cents,
                   unit_cost_cents_snapshot)
                VALUES ($1, $2, $3, 'line_be_1', 1, $4, $4, $5)
                """,
                shop_id,
                order_id,
                sku_id,
                _cents(revenue),
                _cents(cogs),
            )
            await conn.execute(
                """
                INSERT INTO public.attribution_fact
                  (shop_id, order_id, campaign_id, platform,
                   attributed_revenue_cents, attribution_method)
                VALUES ($1, $2, $3, 'meta', $4, 'utm_exact')
                """,
                shop_id,
                order_id,
                campaign_id,
                _cents(revenue),
            )

    return _seed


@pytest.fixture
def seed_regional_starved_scenario(pg_pool):
    """Plan 03 Task 12: ad spend hitting a region whose local stock is empty.

    Allocates spend by tagging the campaign's geo_targets text[] (Plan 02
    has no ``ad_spend_fact.geo`` column). We seed two locations: one in
    the targeted region (with ``ca_stock`` units) and one elsewhere (with
    ``other_stock`` units), so the detector can find stock to transfer.
    """

    sku_id = "44444444-4444-4444-4444-4444444444aa"
    campaign_id = "44444444-4444-4444-4444-4444444444bb"
    region_loc_id = "44444444-4444-4444-4444-4444444444cc"
    other_loc_id = "44444444-4444-4444-4444-4444444444dd"

    async def _seed(
        shop_id: str,
        *,
        region: str,
        spend: Decimal,
        ca_stock: int,
        other_stock: int,
        velocity: Decimal = Decimal("3"),
        unit_margin: Decimal = Decimal("20"),
    ) -> None:
        async with pg_pool.acquire() as conn:
            # Clean up state from prior tests using the same fixed UUIDs.
            await conn.execute(
                "DELETE FROM public.ad_spend_fact WHERE campaign_id = $1",
                campaign_id,
            )
            await conn.execute(
                "DELETE FROM public.ad_creative_sku_map WHERE sku_id = $1",
                sku_id,
            )
            await conn.execute(
                "DELETE FROM public.ad_campaign_dim WHERE id = $1",
                campaign_id,
            )
            await conn.execute(
                "DELETE FROM public.sku_pnl WHERE sku_id = $1",
                sku_id,
            )
            await conn.execute(
                "DELETE FROM public.sku_velocity WHERE sku_id = $1",
                sku_id,
            )
            await conn.execute(
                "DELETE FROM public.inventory_level_fact "
                "WHERE sku_id = $1 OR location_id = ANY($2::uuid[])",
                sku_id,
                [region_loc_id, other_loc_id],
            )
            await conn.execute(
                "DELETE FROM public.location_dim WHERE id = ANY($1::uuid[])",
                [region_loc_id, other_loc_id],
            )
            await conn.execute(
                "DELETE FROM public.sku_dim WHERE id = $1",
                sku_id,
            )
            await conn.execute(
                """
                INSERT INTO public.sku_dim
                  (id, shop_id, external_id, product_id, inventory_item_id,
                   sku, title, unit_cost_cents, currency)
                VALUES ($1, $2, 'ext-rg-1', 'prod-rg-1',
                        'gid://shopify/InventoryItem/44440001',
                        'RG-1', 'Regional SKU', 1500, 'USD')
                """,
                sku_id,
                shop_id,
            )
            await conn.execute(
                """
                INSERT INTO public.location_dim
                  (id, shop_id, external_id, name, country, region, active)
                VALUES ($1, $2, 'loc-region', 'Regional WH', 'US', $3, true)
                """,
                region_loc_id,
                shop_id,
                region,
            )
            await conn.execute(
                """
                INSERT INTO public.location_dim
                  (id, shop_id, external_id, name, country, region, active)
                VALUES ($1, $2, 'loc-other', 'Other WH', 'US', 'NY', true)
                """,
                other_loc_id,
                shop_id,
            )
            await conn.execute(
                """
                INSERT INTO public.inventory_level_fact
                  (shop_id, sku_id, location_id, available, observed_at,
                   source_version)
                VALUES
                  ($1, $2, $3, $4, now(), $5),
                  ($1, $2, $6, $7, now(), $8)
                """,
                shop_id,
                sku_id,
                region_loc_id,
                ca_stock,
                _next_source_version(),
                other_loc_id,
                other_stock,
                _next_source_version(),
            )
            await conn.execute(
                """
                INSERT INTO public.sku_velocity
                  (shop_id, sku_id, location_id, window_days, units, computed_at)
                VALUES ($1, $2, NULL, 1, $3, now())
                """,
                shop_id,
                sku_id,
                velocity,
            )
            margin_cents_per_day = _cents(unit_margin * velocity)
            for day_offset in range(7):
                await conn.execute(
                    """
                    INSERT INTO public.sku_pnl
                      (shop_id, sku_id, day, revenue_cents, cogs_cents,
                       ad_spend_attrib_cents, return_cents,
                       contribution_margin_cents)
                    VALUES ($1, $2, current_date - $3::int,
                            $4, 0, 0, 0, $4)
                    """,
                    shop_id,
                    sku_id,
                    day_offset,
                    margin_cents_per_day,
                )
            # Campaign targets only the given region — spend allocates 1.0
            # to that region by the detector's fan-out CROSS JOIN.
            await conn.execute(
                """
                INSERT INTO public.ad_campaign_dim
                  (id, shop_id, platform, external_id, name, status,
                   currency, geo_targets)
                VALUES ($1, $2, 'meta', 'cmp_reg', 'Regional Campaign',
                        'active', 'USD', ARRAY[$3]::text[])
                """,
                campaign_id,
                shop_id,
                region,
            )
            await conn.execute(
                """
                INSERT INTO public.ad_creative_sku_map
                  (shop_id, platform, creative_id, creative_label, sku_id,
                   confidence, source, confirmed_at)
                VALUES ($1, 'meta', 'creative_reg', 'Reg Creative', $2,
                        0.95, 'merchant_confirmed', now())
                """,
                shop_id,
                sku_id,
            )
            await conn.execute(
                """
                INSERT INTO public.ad_spend_fact
                  (shop_id, campaign_id, day, spend_cents)
                VALUES ($1, $2, current_date, $3)
                """,
                shop_id,
                campaign_id,
                _cents(spend),
            )

    return _seed


@pytest.fixture
def seed_scaling_risk_scenario(pg_pool):
    """Plan 03 Task 13: scaling SKU with sub-threshold days_of_cover.

    Seeds a stockout_forecast row, latest velocity, recent vs. prior 7-day
    spend (to drive the WoW ratio), and a sku_pnl slice for unit margin.
    """

    sku_id = "55555555-5555-5555-5555-5555555555aa"
    campaign_id = "55555555-5555-5555-5555-5555555555bb"
    location_id = "55555555-5555-5555-5555-5555555555cc"

    async def _seed(
        shop_id: str,
        *,
        velocity: Decimal,
        stock: int,
        spend_trend: Decimal,
        unit_margin: Decimal = Decimal("25"),
    ) -> None:
        # Compute days_of_cover = stock / velocity for the forecast row,
        # so the test scenario directly steers the gating condition.
        if velocity > 0:
            days_of_cover = (Decimal(stock) / velocity).quantize(Decimal("0.01"))
        else:
            days_of_cover = Decimal("999.99")

        # spend_trend is the desired spend_this/spend_prev ratio.
        spend_prev = Decimal("100")
        spend_this = (spend_prev * spend_trend).quantize(Decimal("0.01"))

        async with pg_pool.acquire() as conn:
            # Reset state from prior tests using the same fixed UUIDs.
            await conn.execute(
                "DELETE FROM public.ad_spend_fact WHERE campaign_id = $1",
                campaign_id,
            )
            await conn.execute(
                "DELETE FROM public.ad_creative_sku_map WHERE sku_id = $1",
                sku_id,
            )
            await conn.execute(
                "DELETE FROM public.ad_campaign_dim WHERE id = $1",
                campaign_id,
            )
            await conn.execute(
                "DELETE FROM public.sku_pnl WHERE sku_id = $1",
                sku_id,
            )
            await conn.execute(
                "DELETE FROM public.stockout_forecast WHERE sku_id = $1",
                sku_id,
            )
            await conn.execute(
                "DELETE FROM public.sku_velocity WHERE sku_id = $1",
                sku_id,
            )
            await conn.execute(
                "DELETE FROM public.inventory_level_fact "
                "WHERE sku_id = $1 OR location_id = $2",
                sku_id,
                location_id,
            )
            await conn.execute(
                "DELETE FROM public.location_dim WHERE id = $1",
                location_id,
            )
            await conn.execute(
                "DELETE FROM public.sku_dim WHERE id = $1",
                sku_id,
            )
            await conn.execute(
                """
                INSERT INTO public.sku_dim
                  (id, shop_id, external_id, product_id, sku, title,
                   unit_cost_cents, currency)
                VALUES ($1, $2, 'ext-sc-1', 'prod-sc-1', 'SC-1',
                        'Scaling SKU', 2000, 'USD')
                """,
                sku_id,
                shop_id,
            )
            await conn.execute(
                """
                INSERT INTO public.location_dim
                  (id, shop_id, external_id, name, country, region, active)
                VALUES ($1, $2, 'loc-sc', 'Scaling WH', 'US', 'CA', true)
                """,
                location_id,
                shop_id,
            )
            await conn.execute(
                """
                INSERT INTO public.inventory_level_fact
                  (shop_id, sku_id, location_id, available, observed_at,
                   source_version)
                VALUES ($1, $2, $3, $4, now(), $5)
                """,
                shop_id,
                sku_id,
                location_id,
                stock,
                _next_source_version(),
            )
            await conn.execute(
                """
                INSERT INTO public.sku_velocity
                  (shop_id, sku_id, location_id, window_days, units, computed_at)
                VALUES ($1, $2, NULL, 1, $3, now())
                """,
                shop_id,
                sku_id,
                velocity,
            )
            await conn.execute(
                """
                INSERT INTO public.stockout_forecast
                  (shop_id, sku_id, location_id, days_of_cover, computed_at)
                VALUES ($1, $2, NULL, $3, now())
                """,
                shop_id,
                sku_id,
                days_of_cover,
            )
            margin_cents_per_day = _cents(unit_margin * velocity)
            for day_offset in range(7):
                await conn.execute(
                    """
                    INSERT INTO public.sku_pnl
                      (shop_id, sku_id, day, revenue_cents, cogs_cents,
                       ad_spend_attrib_cents, return_cents,
                       contribution_margin_cents)
                    VALUES ($1, $2, current_date - $3::int,
                            $4, 0, 0, 0, $4)
                    """,
                    shop_id,
                    sku_id,
                    day_offset,
                    margin_cents_per_day,
                )
            await conn.execute(
                """
                INSERT INTO public.ad_campaign_dim
                  (id, shop_id, platform, external_id, name, status, currency)
                VALUES ($1, $2, 'meta', 'cmp_scale', 'Scaling Campaign',
                        'active', 'USD')
                """,
                campaign_id,
                shop_id,
            )
            await conn.execute(
                """
                INSERT INTO public.ad_creative_sku_map
                  (shop_id, platform, creative_id, creative_label, sku_id,
                   confidence, source, confirmed_at)
                VALUES ($1, 'meta', 'creative_scale', 'Scale Creative', $2,
                        0.95, 'merchant_confirmed', now())
                """,
                shop_id,
                sku_id,
            )
            # Trailing 7-day spend window: today through 6 days ago.
            await conn.execute(
                """
                INSERT INTO public.ad_spend_fact
                  (shop_id, campaign_id, day, spend_cents)
                VALUES ($1, $2, current_date, $3)
                """,
                shop_id,
                campaign_id,
                _cents(spend_this),
            )
            # Prior 7-day spend window: 8–14 days ago. Place all of it on
            # day -10, comfortably inside the BETWEEN range.
            await conn.execute(
                """
                INSERT INTO public.ad_spend_fact
                  (shop_id, campaign_id, day, spend_cents)
                VALUES ($1, $2, current_date - 10, $3)
                """,
                shop_id,
                campaign_id,
                _cents(spend_prev),
            )

    return _seed


# ---------------------------------------------------------------------------
# Detector scenario fixtures (Plan 03 Tasks 14–17)
#
# These belong to the second batch of detectors:
#   14: return_rate_hidden_loss
#   15: margin_erosion + cogs_drift
#   16: ad_tax_overload + negative_unit_economics
#   17: reorder_timing + wrong_location_concentration + regional_shortage_risk
#
# Each fixture seeds the minimum Plan 02 rows needed and uses _cents() for
# money conversions.
# ---------------------------------------------------------------------------


@pytest.fixture
def seed_return_rate_scenario(pg_pool):
    """Plan 03 Task 14: high return-rate SKU.

    Seeds a SKU, an order with one line (drives ``avg_price`` and
    ``unit_cost_snapshot``), and a 30-day ``sku_pnl`` slice in which the
    returns column is set to ``return_rate * revenue``. The detector reads
    aggregate revenue/return cents from sku_pnl and average price/cost from
    order_line_fact.
    """

    sku_id = "66666666-6666-6666-6666-66666666aaaa"
    order_id = "66666666-6666-6666-6666-66666666bbbb"

    async def _seed(
        shop_id: str,
        *,
        return_rate: Decimal,
        revenue_per_day: Decimal = Decimal("100"),
        unit_price: Decimal = Decimal("50"),
        unit_cost: Decimal = Decimal("15"),
    ) -> None:
        async with pg_pool.acquire() as conn:
            # Reset prior-test state on the fixed UUIDs.
            await conn.execute(
                "DELETE FROM public.order_line_fact WHERE order_id = $1",
                order_id,
            )
            await conn.execute(
                "DELETE FROM public.order_fact WHERE id = $1",
                order_id,
            )
            await conn.execute(
                "DELETE FROM public.sku_pnl WHERE sku_id = $1",
                sku_id,
            )
            await conn.execute(
                "DELETE FROM public.sku_dim WHERE id = $1",
                sku_id,
            )
            await conn.execute(
                """
                INSERT INTO public.sku_dim
                  (id, shop_id, external_id, product_id, sku, title,
                   unit_cost_cents, currency)
                VALUES ($1, $2, 'ext-rr-1', 'prod-rr-1', 'RR-1',
                        'Return-Rate SKU', $3, 'USD')
                """,
                sku_id,
                shop_id,
                _cents(unit_cost),
            )
            # Anchor the order one day ago so 30-day windows include it but
            # 7-day excludes-7 windows still bracket cleanly elsewhere.
            await conn.execute(
                """
                INSERT INTO public.order_fact
                  (id, shop_id, external_id, order_number,
                   created_at_source, total_cents, subtotal_cents,
                   source_version)
                VALUES ($1, $2, 'ord_rr_1', '#RR1',
                        now() - interval '1 day', $3, $3, $4)
                """,
                order_id,
                shop_id,
                _cents(unit_price),
                _next_source_version(),
            )
            await conn.execute(
                """
                INSERT INTO public.order_line_fact
                  (shop_id, order_id, sku_id, external_line_id,
                   quantity, price_cents, total_cents,
                   unit_cost_cents_snapshot)
                VALUES ($1, $2, $3, 'line_rr_1', 1, $4, $4, $5)
                """,
                shop_id,
                order_id,
                sku_id,
                _cents(unit_price),
                _cents(unit_cost),
            )
            revenue_cents_per_day = _cents(revenue_per_day)
            return_cents_per_day = _cents(revenue_per_day * return_rate)
            for day_offset in range(30):
                await conn.execute(
                    """
                    INSERT INTO public.sku_pnl
                      (shop_id, sku_id, day, revenue_cents, cogs_cents,
                       ad_spend_attrib_cents, return_cents,
                       contribution_margin_cents)
                    VALUES ($1, $2, current_date - $3::int,
                            $4, 0, 0, $5, $4)
                    """,
                    shop_id,
                    sku_id,
                    day_offset,
                    revenue_cents_per_day,
                    return_cents_per_day,
                )

    return _seed


@pytest.fixture
def seed_margin_erosion_scenario(pg_pool):
    """Plan 03 Task 15a: SKU whose 7-day unit margin compressed vs prior 30d.

    Seeds two windows of order lines:
    - Baseline window (8–37 days ago): N units at baseline_price/baseline_cost.
    - Current window (last 7 days): N units at current_price/current_cost.

    The detector reconstructs unit margin from
    (price_cents - unit_cost_cents_snapshot) over each window.
    """

    sku_id = "77777777-7777-7777-7777-77777777aaaa"

    cur_order_id = "77777777-7777-7777-7777-77777777c001"
    base_order_id = "77777777-7777-7777-7777-77777777ba5e"

    async def _seed(
        shop_id: str,
        *,
        baseline_unit_margin_usd: Decimal,
        current_unit_margin_usd: Decimal,
        baseline_units: int = 60,
        current_units: int = 60,
        unit_cost_usd: Decimal = Decimal("10"),
    ) -> None:
        # Hold cost flat; vary price to drive margin.
        baseline_price = unit_cost_usd + baseline_unit_margin_usd
        current_price = unit_cost_usd + current_unit_margin_usd
        async with pg_pool.acquire() as conn:
            # Reset prior-test state on the fixed UUIDs.
            await conn.execute(
                "DELETE FROM public.order_line_fact "
                "WHERE order_id = ANY($1::uuid[])",
                [cur_order_id, base_order_id],
            )
            await conn.execute(
                "DELETE FROM public.order_fact WHERE id = ANY($1::uuid[])",
                [cur_order_id, base_order_id],
            )
            await conn.execute(
                "DELETE FROM public.sku_dim WHERE id = $1",
                sku_id,
            )
            await conn.execute(
                """
                INSERT INTO public.sku_dim
                  (id, shop_id, external_id, product_id, sku, title,
                   unit_cost_cents, currency)
                VALUES ($1, $2, 'ext-me-1', 'prod-me-1', 'ME-1',
                        'Margin-Erosion SKU', $3, 'USD')
                """,
                sku_id,
                shop_id,
                _cents(unit_cost_usd),
            )

            async def _insert_order(
                order_uuid: str,
                ext: str,
                line_ext: str,
                created_at_offset_days: int,
                quantity: int,
                price_usd: Decimal,
                cost_usd: Decimal,
            ) -> None:
                await conn.execute(
                    """
                    INSERT INTO public.order_fact
                      (id, shop_id, external_id, order_number,
                       created_at_source, total_cents, subtotal_cents,
                       source_version)
                    VALUES ($1, $2, $3, $4,
                            now() - ($5::int * interval '1 day'),
                            $6, $6, $7)
                    """,
                    order_uuid,
                    shop_id,
                    ext,
                    ext,
                    created_at_offset_days,
                    _cents(price_usd * Decimal(quantity)),
                    _next_source_version(),
                )
                await conn.execute(
                    """
                    INSERT INTO public.order_line_fact
                      (shop_id, order_id, sku_id, external_line_id,
                       quantity, price_cents, total_cents,
                       unit_cost_cents_snapshot)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                    """,
                    shop_id,
                    order_uuid,
                    sku_id,
                    line_ext,
                    quantity,
                    _cents(price_usd),
                    _cents(price_usd * Decimal(quantity)),
                    _cents(cost_usd),
                )

            # Current window: a single bulk order 1 day ago.
            await _insert_order(
                cur_order_id,
                "ord_me_cur",
                "line_me_cur",
                created_at_offset_days=1,
                quantity=current_units,
                price_usd=current_price,
                cost_usd=unit_cost_usd,
            )
            # Baseline window: a bulk order 20 days ago (within 8–37d).
            await _insert_order(
                base_order_id,
                "ord_me_base",
                "line_me_base",
                created_at_offset_days=20,
                quantity=baseline_units,
                price_usd=baseline_price,
                cost_usd=unit_cost_usd,
            )

    return _seed


@pytest.fixture
def seed_cogs_drift_scenario(pg_pool):
    """Plan 03 Task 15b: SKU with two cogs_fact rows whose unit cost drifted.

    Seeds a baseline (older) and current (open, ``effective_to IS NULL``)
    cogs_fact row plus 30 days of order lines so the detector can multiply
    the per-unit drift by the units sold to get a dollar impact.
    """

    sku_id = "88888888-8888-8888-8888-88888888aaaa"
    order_id = "88888888-8888-8888-8888-88888888bbbb"

    async def _seed(
        shop_id: str,
        *,
        prior_unit_cost_usd: Decimal,
        current_unit_cost_usd: Decimal,
        units_30d: int,
    ) -> None:
        async with pg_pool.acquire() as conn:
            # Reset prior-test state on the fixed UUIDs.
            await conn.execute(
                "DELETE FROM public.order_line_fact WHERE order_id = $1",
                order_id,
            )
            await conn.execute(
                "DELETE FROM public.order_fact WHERE id = $1",
                order_id,
            )
            await conn.execute(
                "DELETE FROM public.cogs_fact WHERE sku_id = $1",
                sku_id,
            )
            await conn.execute(
                "DELETE FROM public.sku_dim WHERE id = $1",
                sku_id,
            )
            await conn.execute(
                """
                INSERT INTO public.sku_dim
                  (id, shop_id, external_id, product_id, sku, title,
                   unit_cost_cents, currency)
                VALUES ($1, $2, 'ext-cd-1', 'prod-cd-1', 'CD-1',
                        'COGS-Drift SKU', $3, 'USD')
                """,
                sku_id,
                shop_id,
                _cents(current_unit_cost_usd),
            )
            now = datetime.now(UTC)
            prior_from = now - timedelta(days=60)
            prior_to = now - timedelta(days=10)
            current_from = now - timedelta(days=10)
            await conn.execute(
                """
                INSERT INTO public.cogs_fact
                  (shop_id, sku_id, unit_cost_cents,
                   effective_from, effective_to, source)
                VALUES ($1, $2, $3, $4, $5, 'csv_import')
                """,
                shop_id,
                sku_id,
                _cents(prior_unit_cost_usd),
                prior_from,
                prior_to,
            )
            await conn.execute(
                """
                INSERT INTO public.cogs_fact
                  (shop_id, sku_id, unit_cost_cents,
                   effective_from, effective_to, source)
                VALUES ($1, $2, $3, $4, NULL, 'csv_import')
                """,
                shop_id,
                sku_id,
                _cents(current_unit_cost_usd),
                current_from,
            )
            await conn.execute(
                """
                INSERT INTO public.order_fact
                  (id, shop_id, external_id, order_number,
                   created_at_source, total_cents, subtotal_cents,
                   source_version)
                VALUES ($1, $2, 'ord_cd_1', '#CD1',
                        now() - interval '5 days', 1000, 1000, $3)
                """,
                order_id,
                shop_id,
                _next_source_version(),
            )
            await conn.execute(
                """
                INSERT INTO public.order_line_fact
                  (shop_id, order_id, sku_id, external_line_id,
                   quantity, price_cents, total_cents,
                   unit_cost_cents_snapshot)
                VALUES ($1, $2, $3, 'line_cd_1', $4, 5000,
                        5000 * $4, $5)
                """,
                shop_id,
                order_id,
                sku_id,
                units_30d,
                _cents(current_unit_cost_usd),
            )

    return _seed


@pytest.fixture
def seed_ad_tax_scenario(pg_pool):
    """Plan 03 Task 16a: trailing-7-day ad spend ratio over revenue.

    Seeds one campaign, a single attributed order (revenue), and a single
    ad_spend_fact row covering today.
    """

    campaign_id = "99999999-9999-9999-9999-99999999aaaa"
    order_id = "99999999-9999-9999-9999-99999999bbbb"
    sku_id = "99999999-9999-9999-9999-99999999cccc"

    async def _seed(
        shop_id: str,
        *,
        spend_usd: Decimal,
        revenue_usd: Decimal,
    ) -> None:
        async with pg_pool.acquire() as conn:
            # Reset prior-test state on the fixed UUIDs so each test sees
            # exactly the spend/revenue it asked for.
            await conn.execute(
                "DELETE FROM public.attribution_fact WHERE order_id = $1",
                order_id,
            )
            await conn.execute(
                "DELETE FROM public.order_fact WHERE id = $1",
                order_id,
            )
            await conn.execute(
                "DELETE FROM public.ad_spend_fact WHERE campaign_id = $1",
                campaign_id,
            )
            await conn.execute(
                "DELETE FROM public.ad_campaign_dim WHERE id = $1",
                campaign_id,
            )
            await conn.execute(
                "DELETE FROM public.sku_dim WHERE id = $1",
                sku_id,
            )
            await conn.execute(
                """
                INSERT INTO public.sku_dim
                  (id, shop_id, external_id, product_id, sku, title,
                   unit_cost_cents, currency)
                VALUES ($1, $2, 'ext-at-1', 'prod-at-1', 'AT-1',
                        'AdTax SKU', 1000, 'USD')
                """,
                sku_id,
                shop_id,
            )
            await conn.execute(
                """
                INSERT INTO public.ad_campaign_dim
                  (id, shop_id, platform, external_id, name, status, currency)
                VALUES ($1, $2, 'meta', 'cmp_at', 'AdTax Campaign',
                        'active', 'USD')
                """,
                campaign_id,
                shop_id,
            )
            await conn.execute(
                """
                INSERT INTO public.ad_spend_fact
                  (shop_id, campaign_id, day, spend_cents)
                VALUES ($1, $2, current_date, $3)
                """,
                shop_id,
                campaign_id,
                _cents(spend_usd),
            )
            # Only seed an order/attribution row when revenue is positive.
            # The "no revenue" test wants the detector to see zero attributed
            # revenue, so we skip the order entirely rather than insert a
            # zero-cent row that would still make the ratio undefined.
            if revenue_usd > 0:
                await conn.execute(
                    """
                    INSERT INTO public.order_fact
                      (id, shop_id, external_id, order_number,
                       created_at_source, total_cents, subtotal_cents,
                       source_version)
                    VALUES ($1, $2, 'ord_at_1', '#AT1',
                            now() - interval '1 day', $3, $3, $4)
                    """,
                    order_id,
                    shop_id,
                    _cents(revenue_usd),
                    _next_source_version(),
                )
                await conn.execute(
                    """
                    INSERT INTO public.attribution_fact
                      (shop_id, order_id, campaign_id, platform,
                       attributed_revenue_cents, attribution_method)
                    VALUES ($1, $2, $3, 'meta', $4, 'utm_exact')
                    """,
                    shop_id,
                    order_id,
                    campaign_id,
                    _cents(revenue_usd),
                )

    return _seed


@pytest.fixture
def seed_negative_unit_econ_scenario(pg_pool):
    """Plan 03 Task 16b: SKU whose unit margin minus per-unit CAC is < 0.

    Seeds an order line for unit margin, an ad campaign, an
    ad_creative_sku_map row with ``source = 'merchant_confirmed'``, an
    ad_spend_fact row for CAC, and an attribution_fact row tying the order
    to the campaign so the detector can derive attributed_units.
    """

    sku_id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa1111"
    campaign_id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa2222"
    order_id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa3333"

    async def _seed(
        shop_id: str,
        *,
        unit_price_usd: Decimal,
        unit_cost_usd: Decimal,
        units: int,
        spend_usd: Decimal,
    ) -> None:
        async with pg_pool.acquire() as conn:
            # Reset prior-test state on the fixed UUIDs.
            await conn.execute(
                "DELETE FROM public.attribution_fact WHERE order_id = $1",
                order_id,
            )
            await conn.execute(
                "DELETE FROM public.order_line_fact WHERE order_id = $1",
                order_id,
            )
            await conn.execute(
                "DELETE FROM public.order_fact WHERE id = $1",
                order_id,
            )
            await conn.execute(
                "DELETE FROM public.ad_spend_fact WHERE campaign_id = $1",
                campaign_id,
            )
            await conn.execute(
                "DELETE FROM public.ad_creative_sku_map WHERE sku_id = $1",
                sku_id,
            )
            await conn.execute(
                "DELETE FROM public.ad_campaign_dim WHERE id = $1",
                campaign_id,
            )
            await conn.execute(
                "DELETE FROM public.sku_dim WHERE id = $1",
                sku_id,
            )
            await conn.execute(
                """
                INSERT INTO public.sku_dim
                  (id, shop_id, external_id, product_id, sku, title,
                   unit_cost_cents, currency)
                VALUES ($1, $2, 'ext-ne-1', 'prod-ne-1', 'NE-1',
                        'Negative-Econ SKU', $3, 'USD')
                """,
                sku_id,
                shop_id,
                _cents(unit_cost_usd),
            )
            await conn.execute(
                """
                INSERT INTO public.ad_campaign_dim
                  (id, shop_id, platform, external_id, name, status, currency)
                VALUES ($1, $2, 'meta', 'cmp_ne', 'Negative-Econ Campaign',
                        'active', 'USD')
                """,
                campaign_id,
                shop_id,
            )
            await conn.execute(
                """
                INSERT INTO public.ad_creative_sku_map
                  (shop_id, platform, creative_id, creative_label, sku_id,
                   confidence, source, confirmed_at)
                VALUES ($1, 'meta', 'creative_ne', 'NE Creative', $2,
                        0.95, 'merchant_confirmed', now())
                """,
                shop_id,
                sku_id,
            )
            await conn.execute(
                """
                INSERT INTO public.ad_spend_fact
                  (shop_id, campaign_id, day, spend_cents)
                VALUES ($1, $2, current_date - 1, $3)
                """,
                shop_id,
                campaign_id,
                _cents(spend_usd),
            )
            await conn.execute(
                """
                INSERT INTO public.order_fact
                  (id, shop_id, external_id, order_number,
                   created_at_source, total_cents, subtotal_cents,
                   source_version)
                VALUES ($1, $2, 'ord_ne_1', '#NE1',
                        now() - interval '1 day', $3, $3, $4)
                """,
                order_id,
                shop_id,
                _cents(unit_price_usd * Decimal(units)),
                _next_source_version(),
            )
            await conn.execute(
                """
                INSERT INTO public.order_line_fact
                  (shop_id, order_id, sku_id, external_line_id,
                   quantity, price_cents, total_cents,
                   unit_cost_cents_snapshot)
                VALUES ($1, $2, $3, 'line_ne_1', $4, $5, $6, $7)
                """,
                shop_id,
                order_id,
                sku_id,
                units,
                _cents(unit_price_usd),
                _cents(unit_price_usd * Decimal(units)),
                _cents(unit_cost_usd),
            )
            await conn.execute(
                """
                INSERT INTO public.attribution_fact
                  (shop_id, order_id, campaign_id, platform,
                   attributed_revenue_cents, attribution_method)
                VALUES ($1, $2, $3, 'meta', $4, 'utm_exact')
                """,
                shop_id,
                order_id,
                campaign_id,
                _cents(unit_price_usd * Decimal(units)),
            )

    return _seed


@pytest.fixture
def seed_reorder_timing_scenario(pg_pool):
    """Plan 03 Task 17a: SKU whose latest stockout_forecast.days_of_cover is
    below the assumed 14-day vendor lead time."""

    sku_id = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbb1111"
    location_id = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbb2222"
    order_id = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbb3333"

    async def _seed(
        shop_id: str,
        *,
        days_of_cover: Decimal,
        velocity_per_day: Decimal,
        unit_margin_usd: Decimal,
    ) -> None:
        async with pg_pool.acquire() as conn:
            # Reset prior-test state on the fixed UUIDs.
            await conn.execute(
                "DELETE FROM public.order_line_fact WHERE order_id = $1",
                order_id,
            )
            await conn.execute(
                "DELETE FROM public.order_fact WHERE id = $1",
                order_id,
            )
            await conn.execute(
                "DELETE FROM public.stockout_forecast WHERE sku_id = $1",
                sku_id,
            )
            await conn.execute(
                "DELETE FROM public.sku_velocity WHERE sku_id = $1",
                sku_id,
            )
            await conn.execute(
                "DELETE FROM public.location_dim WHERE id = $1",
                location_id,
            )
            await conn.execute(
                "DELETE FROM public.sku_dim WHERE id = $1",
                sku_id,
            )
            await conn.execute(
                """
                INSERT INTO public.sku_dim
                  (id, shop_id, external_id, product_id, sku, title,
                   unit_cost_cents, currency)
                VALUES ($1, $2, 'ext-ro-1', 'prod-ro-1', 'RO-1',
                        'Reorder SKU', 1000, 'USD')
                """,
                sku_id,
                shop_id,
            )
            await conn.execute(
                """
                INSERT INTO public.location_dim
                  (id, shop_id, external_id, name, country, region, active)
                VALUES ($1, $2, 'loc-ro', 'Reorder WH', 'US', 'CA', true)
                """,
                location_id,
                shop_id,
            )
            await conn.execute(
                """
                INSERT INTO public.stockout_forecast
                  (shop_id, sku_id, location_id, days_of_cover, computed_at)
                VALUES ($1, $2, NULL, $3, now())
                """,
                shop_id,
                sku_id,
                days_of_cover,
            )
            # 7-day velocity row: store as window_days=7, units = velocity*7.
            await conn.execute(
                """
                INSERT INTO public.sku_velocity
                  (shop_id, sku_id, location_id, window_days, units, computed_at)
                VALUES ($1, $2, NULL, 7, $3, now())
                """,
                shop_id,
                sku_id,
                velocity_per_day * Decimal("7"),
            )
            # Single order line establishes unit margin via price - cost.
            unit_cost_usd = Decimal("10")
            unit_price_usd = unit_cost_usd + unit_margin_usd
            await conn.execute(
                """
                INSERT INTO public.order_fact
                  (id, shop_id, external_id, order_number,
                   created_at_source, total_cents, subtotal_cents,
                   source_version)
                VALUES ($1, $2, 'ord_ro_1', '#RO1',
                        now() - interval '5 days', $3, $3, $4)
                """,
                order_id,
                shop_id,
                _cents(unit_price_usd * Decimal("10")),
                _next_source_version(),
            )
            await conn.execute(
                """
                INSERT INTO public.order_line_fact
                  (shop_id, order_id, sku_id, external_line_id,
                   quantity, price_cents, total_cents,
                   unit_cost_cents_snapshot)
                VALUES ($1, $2, $3, 'line_ro_1', 10, $4, $5, $6)
                """,
                shop_id,
                order_id,
                sku_id,
                _cents(unit_price_usd),
                _cents(unit_price_usd * Decimal("10")),
                _cents(unit_cost_usd),
            )

    return _seed


@pytest.fixture
def seed_wrong_location_scenario(pg_pool):
    """Plan 03 Task 17b: 80%+ stock at a low-demand-region location.

    Seeds two locations in two regions, latest inventory snapshots, and an
    order whose fulfillment_fact maps demand to the *other* region.
    """

    sku_id = "cccccccc-cccc-cccc-cccc-cccccccc1111"
    high_loc = "cccccccc-cccc-cccc-cccc-cccccccc2222"
    low_loc = "cccccccc-cccc-cccc-cccc-cccccccc3333"
    order_id = "cccccccc-cccc-cccc-cccc-cccccccc4444"
    fulfillment_id = "cccccccc-cccc-cccc-cccc-cccccccc5555"

    async def _seed(
        shop_id: str,
        *,
        high_region: str,
        low_region: str,
        high_qty: int,
        low_qty: int,
        demand_units_at_low: int,
        demand_units_at_high: int,
        unit_margin_usd: Decimal = Decimal("20"),
    ) -> None:
        async with pg_pool.acquire() as conn:
            # Reset prior-test state on the fixed UUIDs.
            await conn.execute(
                "DELETE FROM public.fulfillment_fact WHERE order_id = $1",
                order_id,
            )
            await conn.execute(
                "DELETE FROM public.order_line_fact WHERE order_id = $1",
                order_id,
            )
            await conn.execute(
                "DELETE FROM public.order_fact WHERE id = $1",
                order_id,
            )
            await conn.execute(
                "DELETE FROM public.inventory_level_fact "
                "WHERE sku_id = $1 OR location_id = ANY($2::uuid[])",
                sku_id,
                [high_loc, low_loc],
            )
            await conn.execute(
                "DELETE FROM public.location_dim WHERE id = ANY($1::uuid[])",
                [high_loc, low_loc],
            )
            await conn.execute(
                "DELETE FROM public.sku_dim WHERE id = $1",
                sku_id,
            )
            await conn.execute(
                """
                INSERT INTO public.sku_dim
                  (id, shop_id, external_id, product_id, sku, title,
                   unit_cost_cents, currency)
                VALUES ($1, $2, 'ext-wl-1', 'prod-wl-1', 'WL-1',
                        'Wrong-Location SKU', 1000, 'USD')
                """,
                sku_id,
                shop_id,
            )
            await conn.execute(
                """
                INSERT INTO public.location_dim
                  (id, shop_id, external_id, name, country, region, active)
                VALUES ($1, $2, 'loc-wl-high', 'High-Stock WH', 'US', $3, true)
                """,
                high_loc,
                shop_id,
                high_region,
            )
            await conn.execute(
                """
                INSERT INTO public.location_dim
                  (id, shop_id, external_id, name, country, region, active)
                VALUES ($1, $2, 'loc-wl-low', 'Low-Stock WH', 'US', $3, true)
                """,
                low_loc,
                shop_id,
                low_region,
            )
            await conn.execute(
                """
                INSERT INTO public.inventory_level_fact
                  (shop_id, sku_id, location_id, available, observed_at,
                   source_version)
                VALUES
                  ($1, $2, $3, $4, now(), $5),
                  ($1, $2, $6, $7, now(), $8)
                """,
                shop_id,
                sku_id,
                high_loc,
                high_qty,
                _next_source_version(),
                low_loc,
                low_qty,
                _next_source_version(),
            )
            unit_cost_usd = Decimal("10")
            unit_price_usd = unit_cost_usd + unit_margin_usd
            # Order fulfilled from the low-region (where demand actually is).
            await conn.execute(
                """
                INSERT INTO public.order_fact
                  (id, shop_id, external_id, order_number,
                   created_at_source, total_cents, subtotal_cents,
                   source_version)
                VALUES ($1, $2, 'ord_wl_1', '#WL1',
                        now() - interval '5 days', $3, $3, $4)
                """,
                order_id,
                shop_id,
                _cents(unit_price_usd * Decimal(demand_units_at_low + demand_units_at_high)),
                _next_source_version(),
            )
            # Two lines, two fulfillments — but order_line_fact has no
            # location field; fulfillment_fact carries the location. We use
            # one fulfillment per region and split the line quantity.
            if demand_units_at_low > 0:
                await conn.execute(
                    """
                    INSERT INTO public.order_line_fact
                      (shop_id, order_id, sku_id, external_line_id,
                       quantity, price_cents, total_cents,
                       unit_cost_cents_snapshot)
                    VALUES ($1, $2, $3, 'line_wl_low', $4, $5, $6, $7)
                    """,
                    shop_id,
                    order_id,
                    sku_id,
                    demand_units_at_low,
                    _cents(unit_price_usd),
                    _cents(unit_price_usd * Decimal(demand_units_at_low)),
                    _cents(unit_cost_usd),
                )
                await conn.execute(
                    """
                    INSERT INTO public.fulfillment_fact
                      (id, shop_id, order_id, external_id, location_id,
                       status, source_version)
                    VALUES ($1, $2, $3, 'ff_wl_low', $4, 'success', $5)
                    """,
                    fulfillment_id,
                    shop_id,
                    order_id,
                    low_loc,
                    _next_source_version(),
                )
            if demand_units_at_high > 0:
                await conn.execute(
                    """
                    INSERT INTO public.order_line_fact
                      (shop_id, order_id, sku_id, external_line_id,
                       quantity, price_cents, total_cents,
                       unit_cost_cents_snapshot)
                    VALUES ($1, $2, $3, 'line_wl_high', $4, $5, $6, $7)
                    """,
                    shop_id,
                    order_id,
                    sku_id,
                    demand_units_at_high,
                    _cents(unit_price_usd),
                    _cents(unit_price_usd * Decimal(demand_units_at_high)),
                    _cents(unit_cost_usd),
                )
                await conn.execute(
                    """
                    INSERT INTO public.fulfillment_fact
                      (shop_id, order_id, external_id, location_id,
                       status, source_version)
                    VALUES ($1, $2, 'ff_wl_high', $3, 'success', $4)
                    """,
                    shop_id,
                    order_id,
                    high_loc,
                    _next_source_version(),
                )

    return _seed


@pytest.fixture
def seed_regional_shortage_scenario(pg_pool):
    """Plan 03 Task 17c: a region whose 14-day projected demand exceeds
    its in-region stock.

    Seeds two locations, an order/fulfillment in the focus region (driving
    daily_demand), and an inventory snapshot smaller than
    ``daily_demand * 14``.
    """

    sku_id = "dddddddd-dddd-dddd-dddd-dddddddd1111"
    region_loc = "dddddddd-dddd-dddd-dddd-dddddddd2222"
    other_loc = "dddddddd-dddd-dddd-dddd-dddddddd3333"
    order_id = "dddddddd-dddd-dddd-dddd-dddddddd4444"
    fulfillment_id = "dddddddd-dddd-dddd-dddd-dddddddd5555"

    async def _seed(
        shop_id: str,
        *,
        region: str,
        regional_stock: int,
        units_30d: int,
        unit_margin_usd: Decimal = Decimal("20"),
    ) -> None:
        async with pg_pool.acquire() as conn:
            # Reset prior-test state on the fixed UUIDs. This includes the
            # order/fulfillment rows so each test sees only its own demand
            # signal — without this, an earlier test's order persists and
            # later "no demand" / "stock covers lead time" tests still see
            # demand because the order row is unchanged.
            await conn.execute(
                "DELETE FROM public.fulfillment_fact WHERE order_id = $1",
                order_id,
            )
            await conn.execute(
                "DELETE FROM public.order_line_fact WHERE order_id = $1",
                order_id,
            )
            await conn.execute(
                "DELETE FROM public.order_fact WHERE id = $1",
                order_id,
            )
            await conn.execute(
                "DELETE FROM public.inventory_level_fact "
                "WHERE sku_id = $1 OR location_id = ANY($2::uuid[])",
                sku_id,
                [region_loc, other_loc],
            )
            await conn.execute(
                "DELETE FROM public.location_dim WHERE id = ANY($1::uuid[])",
                [region_loc, other_loc],
            )
            await conn.execute(
                "DELETE FROM public.sku_dim WHERE id = $1",
                sku_id,
            )
            await conn.execute(
                """
                INSERT INTO public.sku_dim
                  (id, shop_id, external_id, product_id, sku, title,
                   unit_cost_cents, currency)
                VALUES ($1, $2, 'ext-rs-1', 'prod-rs-1', 'RS-1',
                        'Regional-Shortage SKU', 1000, 'USD')
                """,
                sku_id,
                shop_id,
            )
            await conn.execute(
                """
                INSERT INTO public.location_dim
                  (id, shop_id, external_id, name, country, region, active)
                VALUES ($1, $2, 'loc-rs-region', 'Region WH', 'US', $3, true)
                """,
                region_loc,
                shop_id,
                region,
            )
            await conn.execute(
                """
                INSERT INTO public.location_dim
                  (id, shop_id, external_id, name, country, region, active)
                VALUES ($1, $2, 'loc-rs-other', 'Other WH', 'US', 'NY', true)
                """,
                other_loc,
                shop_id,
            )
            await conn.execute(
                """
                INSERT INTO public.inventory_level_fact
                  (shop_id, sku_id, location_id, available, observed_at,
                   source_version)
                VALUES ($1, $2, $3, $4, now(), $5)
                """,
                shop_id,
                sku_id,
                region_loc,
                regional_stock,
                _next_source_version(),
            )
            unit_cost_usd = Decimal("10")
            unit_price_usd = unit_cost_usd + unit_margin_usd
            # Only seed an order/fulfillment when there's actually demand;
            # the "no demand" test passes units_30d=0 and expects zero
            # demand rows, not a zero-quantity order line.
            if units_30d > 0:
                await conn.execute(
                    """
                    INSERT INTO public.order_fact
                      (id, shop_id, external_id, order_number,
                       created_at_source, total_cents, subtotal_cents,
                       source_version)
                    VALUES ($1, $2, 'ord_rs_1', '#RS1',
                            now() - interval '5 days', $3, $3, $4)
                    """,
                    order_id,
                    shop_id,
                    _cents(unit_price_usd * Decimal(units_30d)),
                    _next_source_version(),
                )
                await conn.execute(
                    """
                    INSERT INTO public.order_line_fact
                      (shop_id, order_id, sku_id, external_line_id,
                       quantity, price_cents, total_cents,
                       unit_cost_cents_snapshot)
                    VALUES ($1, $2, $3, 'line_rs_1', $4, $5, $6, $7)
                    """,
                    shop_id,
                    order_id,
                    sku_id,
                    units_30d,
                    _cents(unit_price_usd),
                    _cents(unit_price_usd * Decimal(units_30d)),
                    _cents(unit_cost_usd),
                )
                await conn.execute(
                    """
                    INSERT INTO public.fulfillment_fact
                      (id, shop_id, order_id, external_id, location_id,
                       status, source_version)
                    VALUES ($1, $2, $3, 'ff_rs_1', $4, 'success', $5)
                    """,
                    fulfillment_id,
                    shop_id,
                    order_id,
                    region_loc,
                    _next_source_version(),
                )

    return _seed
