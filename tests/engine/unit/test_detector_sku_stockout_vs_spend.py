"""Plan 03 Task 10: detector ``sku_stockout_vs_spend``.

DB-gated tests — they need ``TEST_DATABASE_URL``/``DATABASE_URL`` set, and
the conftest ``pg_pool`` fixture skips them otherwise. The vocabulary in
the plan calls these "unit" tests but they round-trip the actual SQL
against a real Postgres, so they are de facto integration tests.
"""

from __future__ import annotations

from datetime import datetime, UTC
from decimal import Decimal

import pytest

from calderyn_engine.db import with_shop_context
from calderyn_engine.detectors.sku_stockout_vs_spend import (
    DEFAULT_THRESHOLD_USD,
    detect,
)

SHOP = "00000000-0000-0000-0000-0000000000b1"
NOW = datetime(2026, 4, 19, tzinfo=UTC)


@pytest.mark.asyncio
async def test_fires_when_spend_on_stockout_sku_exceeds_threshold(
    pg_pool, seed_shop, seed_stockout_scenario
) -> None:
    await seed_shop(SHOP)
    await seed_stockout_scenario(
        SHOP,
        spend_usd=Decimal("900"),
        stock_on_hand=0,
        velocity=Decimal("8"),
        unit_margin=Decimal("30"),
    )
    async with pg_pool.acquire() as conn:
        async with with_shop_context(conn, SHOP):
            results = await detect(SHOP, conn, NOW)
    assert len(results) == 1
    r = results[0]
    assert r.detector_id == "sku_stockout_vs_spend"
    assert r.severity in ("high", "critical")
    # Stockout loss = 8 units/day * 1 day * $30 margin = $240; the
    # detector falls back to the wasted spend ($900) only if the
    # estimator returns zero, which it doesn't here.
    assert r.dollar_impact >= Decimal("240")


@pytest.mark.asyncio
async def test_does_not_fire_below_threshold(
    pg_pool, seed_shop, seed_stockout_scenario
) -> None:
    await seed_shop(SHOP)
    await seed_stockout_scenario(
        SHOP,
        spend_usd=Decimal("50"),  # well under DEFAULT_THRESHOLD_USD
        stock_on_hand=0,
        velocity=Decimal("1"),
        unit_margin=Decimal("5"),
    )
    async with pg_pool.acquire() as conn:
        async with with_shop_context(conn, SHOP):
            results = await detect(SHOP, conn, NOW)
    assert results == []


@pytest.mark.asyncio
async def test_does_not_fire_when_sku_has_stock(
    pg_pool, seed_shop, seed_stockout_scenario
) -> None:
    await seed_shop(SHOP)
    await seed_stockout_scenario(
        SHOP,
        spend_usd=Decimal("1000"),
        stock_on_hand=100,  # not stocked out
        velocity=Decimal("10"),
        unit_margin=Decimal("30"),
    )
    async with pg_pool.acquire() as conn:
        async with with_shop_context(conn, SHOP):
            results = await detect(SHOP, conn, NOW)
    assert results == []


@pytest.mark.asyncio
async def test_threshold_constant_is_500_usd() -> None:
    # Pinning the documented default so a future tweak can't accidentally
    # silently change merchant-visible behaviour.
    assert DEFAULT_THRESHOLD_USD == Decimal("500")
