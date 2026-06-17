"""Detector ``campaign_scaling_opportunity``: winning campaigns worth scaling.

DB-gated (needs TEST_DATABASE_URL); skipped otherwise via the pg_pool fixture.
Mirrors test_detector_campaign_below_breakeven.py's harness.
"""

from __future__ import annotations

from datetime import datetime, UTC
from decimal import Decimal

import pytest

from calderyn_engine.db import with_shop_context
from calderyn_engine.detectors.campaign_scaling_opportunity import (
    DEFAULT_THRESHOLD_USD,
    detect,
)

SHOP = "00000000-0000-0000-0000-0000000000c1"
NOW = datetime(2026, 6, 16, tzinfo=UTC)


def test_threshold_constant_is_25_usd() -> None:
    assert DEFAULT_THRESHOLD_USD == Decimal("25")


@pytest.mark.asyncio
async def test_fires_for_a_winning_campaign(pg_pool, seed_shop, seed_scale_scenario) -> None:
    await seed_shop(SHOP)
    # grade 'winning', roas 3.0, margin 0.5, budget $100/day; default +20%, 30d
    # => upside 20 * 0.5 * 30 = $300 >= $25 threshold.
    await seed_scale_scenario(SHOP, grade="winning", roas=Decimal("3.0"), margin=Decimal("0.5"), daily_budget_cents=10_000)
    async with pg_pool.acquire() as conn:
        async with with_shop_context(conn, SHOP):
            results = await detect(SHOP, conn, NOW)
    assert len(results) == 1
    r = results[0]
    assert r.detector_id == "campaign_scaling_opportunity"
    assert r.entity_ref["campaign_id"]
    assert r.dollar_impact == Decimal("300.00")


@pytest.mark.asyncio
async def test_does_not_fire_for_non_winning(pg_pool, seed_shop, seed_scale_scenario) -> None:
    await seed_shop(SHOP)
    await seed_scale_scenario(SHOP, grade="okay", roas=Decimal("2.0"), margin=Decimal("0.5"), daily_budget_cents=10_000)
    async with pg_pool.acquire() as conn:
        async with with_shop_context(conn, SHOP):
            results = await detect(SHOP, conn, NOW)
    assert results == []


@pytest.mark.asyncio
async def test_does_not_fire_below_threshold(pg_pool, seed_shop, seed_scale_scenario) -> None:
    await seed_shop(SHOP)
    # $5/day budget, +20% = $1/day, net 0.5 => 1*0.5*30 = $15 < $25.
    await seed_scale_scenario(SHOP, grade="winning", roas=Decimal("3.0"), margin=Decimal("0.5"), daily_budget_cents=500)
    async with pg_pool.acquire() as conn:
        async with with_shop_context(conn, SHOP):
            results = await detect(SHOP, conn, NOW)
    assert results == []


@pytest.mark.asyncio
async def test_does_not_fire_with_no_budget(pg_pool, seed_shop, seed_scale_scenario) -> None:
    await seed_shop(SHOP)
    await seed_scale_scenario(SHOP, grade="winning", roas=Decimal("3.0"), margin=Decimal("0.5"), daily_budget_cents=0)
    async with pg_pool.acquire() as conn:
        async with with_shop_context(conn, SHOP):
            results = await detect(SHOP, conn, NOW)
    assert results == []
