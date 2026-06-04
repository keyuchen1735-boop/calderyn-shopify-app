"""Unit tests for the ``wrong_location_concentration`` detector."""
from __future__ import annotations

from datetime import datetime, UTC
from decimal import Decimal

import pytest

from calderyn_engine.db import with_shop_context
from calderyn_engine.detectors.wrong_location_concentration import detect

SHOP = "00000000-0000-0000-0000-0000000000c1"
NOW = datetime(2026, 4, 19, tzinfo=UTC)


@pytest.mark.asyncio
async def test_fires_when_stock_concentrated_off_demand(
    pg_pool, seed_shop, seed_wrong_location_scenario
) -> None:
    await seed_shop(SHOP)
    # 900 units in NY warehouse (90% of stock), 100 in CA. Demand: 100 units
    # fulfilled in CA, 0 in NY. NY demand share = 0% < 30% ⇒ fires for NY.
    await seed_wrong_location_scenario(
        SHOP,
        high_region="NY",
        low_region="CA",
        high_qty=900,
        low_qty=100,
        demand_units_at_low=100,
        demand_units_at_high=0,
        unit_margin_usd=Decimal("30"),
    )
    async with pg_pool.acquire() as conn:
        async with with_shop_context(conn, SHOP):
            results = await detect(SHOP, conn, NOW)

    assert len(results) == 1
    r = results[0]
    assert r.detector_id == "wrong_location_concentration"
    # Impact = 900 units * $30 margin * 0.1 = $2700.
    assert r.dollar_impact == Decimal("2700.00")
    assert r.entity_ref["region"] == "NY"


@pytest.mark.asyncio
async def test_does_not_fire_when_stock_aligned_with_demand(
    pg_pool, seed_shop, seed_wrong_location_scenario
) -> None:
    await seed_shop(SHOP)
    # 900 units in NY, but 100% of demand is *also* fulfilled from NY ⇒
    # demand_share=1.0 ≥ 0.30 ⇒ does not fire.
    await seed_wrong_location_scenario(
        SHOP,
        high_region="NY",
        low_region="CA",
        high_qty=900,
        low_qty=100,
        demand_units_at_low=0,
        demand_units_at_high=100,
        unit_margin_usd=Decimal("30"),
    )
    async with pg_pool.acquire() as conn:
        async with with_shop_context(conn, SHOP):
            results = await detect(SHOP, conn, NOW)

    assert results == []


@pytest.mark.asyncio
async def test_does_not_fire_when_stock_evenly_distributed(
    pg_pool, seed_shop, seed_wrong_location_scenario
) -> None:
    await seed_shop(SHOP)
    # 50/50 split — neither location is over 80% concentration.
    await seed_wrong_location_scenario(
        SHOP,
        high_region="NY",
        low_region="CA",
        high_qty=500,
        low_qty=500,
        demand_units_at_low=100,
        demand_units_at_high=0,
        unit_margin_usd=Decimal("30"),
    )
    async with pg_pool.acquire() as conn:
        async with with_shop_context(conn, SHOP):
            results = await detect(SHOP, conn, NOW)

    assert results == []
