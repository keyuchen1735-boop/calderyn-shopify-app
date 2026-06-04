"""Plan 03 Task 12: detector ``regional_spend_starved_stock``.

DB-gated; the ``pg_pool`` fixture skips when no test DB URL is available.
"""

from __future__ import annotations

from datetime import datetime, UTC
from decimal import Decimal

import pytest

from calderyn_engine.db import with_shop_context
from calderyn_engine.detectors.regional_spend_starved_stock import (
    DEFAULT_SPEND_THRESHOLD,
    detect,
)

SHOP = "00000000-0000-0000-0000-0000000000b3"
NOW = datetime(2026, 4, 19, tzinfo=UTC)


@pytest.mark.asyncio
async def test_fires_when_geo_spend_high_but_local_stock_empty(
    pg_pool, seed_shop, seed_regional_starved_scenario
) -> None:
    await seed_shop(SHOP)
    # CA campaign got $800 in spend; CA warehouse has 0 stock; another
    # warehouse has 200 units.
    await seed_regional_starved_scenario(
        SHOP,
        region="CA",
        spend=Decimal("800"),
        ca_stock=0,
        other_stock=200,
    )
    async with pg_pool.acquire() as conn:
        async with with_shop_context(conn, SHOP):
            results = await detect(SHOP, conn, NOW)
    assert len(results) == 1
    r = results[0]
    assert r.detector_id == "regional_spend_starved_stock"
    assert r.entity_ref["region"] == "CA"
    assert r.dollar_impact > Decimal("0")


@pytest.mark.asyncio
async def test_does_not_fire_when_region_has_stock(
    pg_pool, seed_shop, seed_regional_starved_scenario
) -> None:
    await seed_shop(SHOP)
    await seed_regional_starved_scenario(
        SHOP,
        region="CA",
        spend=Decimal("800"),
        ca_stock=100,  # local stock available — no shortfall.
        other_stock=200,
    )
    async with pg_pool.acquire() as conn:
        async with with_shop_context(conn, SHOP):
            results = await detect(SHOP, conn, NOW)
    assert results == []


@pytest.mark.asyncio
async def test_does_not_fire_when_no_stock_to_transfer(
    pg_pool, seed_shop, seed_regional_starved_scenario
) -> None:
    await seed_shop(SHOP)
    # CA empty *and* nowhere else has stock — there's nothing to
    # reallocate, so this is a different problem (pure stockout).
    await seed_regional_starved_scenario(
        SHOP,
        region="CA",
        spend=Decimal("800"),
        ca_stock=0,
        other_stock=0,
    )
    async with pg_pool.acquire() as conn:
        async with with_shop_context(conn, SHOP):
            results = await detect(SHOP, conn, NOW)
    assert results == []


@pytest.mark.asyncio
async def test_threshold_constant_is_500_usd() -> None:
    assert DEFAULT_SPEND_THRESHOLD == Decimal("500")
