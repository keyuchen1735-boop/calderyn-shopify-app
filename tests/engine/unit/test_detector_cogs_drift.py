"""Unit tests for the ``cogs_drift`` detector."""
from __future__ import annotations

from datetime import datetime, UTC
from decimal import Decimal

import pytest

from calderyn_engine.db import with_shop_context
from calderyn_engine.detectors.cogs_drift import detect

SHOP = "00000000-0000-0000-0000-0000000000b7"
NOW = datetime(2026, 4, 19, tzinfo=UTC)


@pytest.mark.asyncio
async def test_fires_when_cogs_drifted_up(
    pg_pool, seed_shop, seed_cogs_drift_scenario
) -> None:
    await seed_shop(SHOP)
    # Prior $10, current $15 (50% drift). Units 30d = 200 ⇒ impact $1000.
    await seed_cogs_drift_scenario(
        SHOP,
        prior_unit_cost_usd=Decimal("10"),
        current_unit_cost_usd=Decimal("15"),
        units_30d=200,
    )
    async with pg_pool.acquire() as conn:
        async with with_shop_context(conn, SHOP):
            results = await detect(SHOP, conn, NOW)

    assert len(results) == 1
    r = results[0]
    assert r.detector_id == "cogs_drift"
    assert r.dollar_impact == Decimal("1000.00")
    assert r.severity == "high"


@pytest.mark.asyncio
async def test_does_not_fire_when_drift_below_threshold(
    pg_pool, seed_shop, seed_cogs_drift_scenario
) -> None:
    await seed_shop(SHOP)
    # 5% drift, below the 10% threshold.
    await seed_cogs_drift_scenario(
        SHOP,
        prior_unit_cost_usd=Decimal("10"),
        current_unit_cost_usd=Decimal("10.50"),
        units_30d=200,
    )
    async with pg_pool.acquire() as conn:
        async with with_shop_context(conn, SHOP):
            results = await detect(SHOP, conn, NOW)

    assert results == []


@pytest.mark.asyncio
async def test_does_not_fire_when_cogs_decreased(
    pg_pool, seed_shop, seed_cogs_drift_scenario
) -> None:
    await seed_shop(SHOP)
    # Cost went *down* 30% — favourable, do not alert.
    await seed_cogs_drift_scenario(
        SHOP,
        prior_unit_cost_usd=Decimal("10"),
        current_unit_cost_usd=Decimal("7"),
        units_30d=200,
    )
    async with pg_pool.acquire() as conn:
        async with with_shop_context(conn, SHOP):
            results = await detect(SHOP, conn, NOW)

    assert results == []
