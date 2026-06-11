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
async def test_emits_transfer_plan_evidence_for_reallocate_inventory(
    pg_pool, seed_shop, seed_regional_starved_scenario
) -> None:
    """The alert must carry the concrete source→dest transfer that the
    ``reallocate_inventory`` action replays into Shopify's
    inventoryAdjustQuantities: the SKU's Shopify inventory item, an active
    destination location in the starved region, the source location elsewhere
    that actually holds stock, and a delta bounded by that source.
    """
    await seed_shop(SHOP)
    # 3 units/day velocity ⇒ a week of demand is 21 units; the 'other'
    # warehouse holds 200, so the recommended transfer is the full 21.
    await seed_regional_starved_scenario(
        SHOP,
        region="CA",
        spend=Decimal("800"),
        ca_stock=0,
        other_stock=200,
        velocity=Decimal("3"),
    )
    async with pg_pool.acquire() as conn:
        async with with_shop_context(conn, SHOP):
            results = await detect(SHOP, conn, NOW)
    assert len(results) == 1
    ev = results[0].evidence
    # These four flow verbatim into the Shopify mutation, so they must be the
    # dims' Shopify external ids (GIDs), never internal uuids.
    assert ev["inventory_item_id"] == "gid://shopify/InventoryItem/44440001"
    assert ev["to_location_id"] == "loc-region"   # active location in the starved region
    assert ev["from_location_id"] == "loc-other"  # warehouse elsewhere holding stock
    assert ev["recommended_delta"] == 21          # min(velocity*7, source stock)


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
