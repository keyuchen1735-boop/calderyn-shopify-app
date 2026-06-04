"""Plan 03 Task 13: detector ``scaling_sku_fulfillment_risk``.

DB-gated; the ``pg_pool`` fixture skips when no test DB URL is set.
"""

from __future__ import annotations

from datetime import datetime, UTC
from decimal import Decimal

import pytest

from calderyn_engine.db import with_shop_context
from calderyn_engine.detectors.scaling_sku_fulfillment_risk import (
    DAYS_OF_COVER_THRESHOLD,
    SPEND_TREND_THRESHOLD,
    detect,
)

SHOP = "00000000-0000-0000-0000-0000000000b4"
NOW = datetime(2026, 4, 19, tzinfo=UTC)


@pytest.mark.asyncio
async def test_fires_when_days_of_cover_below_threshold(
    pg_pool, seed_shop, seed_scaling_risk_scenario
) -> None:
    await seed_shop(SHOP)
    # velocity 20/day, stock 30 ⇒ days_of_cover = 1.5; spend doubled
    # week-over-week so the trend gate also fires.
    await seed_scaling_risk_scenario(
        SHOP,
        velocity=Decimal("20"),
        stock=30,
        spend_trend=Decimal("2.0"),
    )
    async with pg_pool.acquire() as conn:
        async with with_shop_context(conn, SHOP):
            results = await detect(SHOP, conn, NOW)
    assert len(results) == 1
    r = results[0]
    assert r.detector_id == "scaling_sku_fulfillment_risk"
    # 1.5 days < 2 ⇒ severity should be critical.
    assert r.severity == "critical"
    assert r.dollar_impact > Decimal("0")


@pytest.mark.asyncio
async def test_does_not_fire_when_cover_is_sufficient(
    pg_pool, seed_shop, seed_scaling_risk_scenario
) -> None:
    await seed_shop(SHOP)
    # velocity 5/day, stock 200 ⇒ 40 days of cover; spend flat.
    await seed_scaling_risk_scenario(
        SHOP,
        velocity=Decimal("5"),
        stock=200,
        spend_trend=Decimal("1.0"),
    )
    async with pg_pool.acquire() as conn:
        async with with_shop_context(conn, SHOP):
            results = await detect(SHOP, conn, NOW)
    assert results == []


@pytest.mark.asyncio
async def test_does_not_fire_when_spend_trend_is_flat(
    pg_pool, seed_shop, seed_scaling_risk_scenario
) -> None:
    await seed_shop(SHOP)
    # Cover is dangerously low, but spend isn't scaling — no scaling
    # signal so the alert is suppressed (a different detector handles
    # plain-stockout cases).
    await seed_scaling_risk_scenario(
        SHOP,
        velocity=Decimal("20"),
        stock=30,
        spend_trend=Decimal("1.0"),  # flat
    )
    async with pg_pool.acquire() as conn:
        async with with_shop_context(conn, SHOP):
            results = await detect(SHOP, conn, NOW)
    assert results == []


@pytest.mark.asyncio
async def test_threshold_constants_pinned() -> None:
    assert DAYS_OF_COVER_THRESHOLD == Decimal("5")
    assert SPEND_TREND_THRESHOLD == Decimal("1.5")
