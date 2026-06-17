"""Unit tests for the ``reorder_timing`` detector."""
from __future__ import annotations

from datetime import datetime, UTC
from decimal import Decimal

import pytest

from calderyn_engine.db import with_shop_context
from calderyn_engine.detectors.reorder_timing import detect

SHOP = "00000000-0000-0000-0000-0000000000c0"
NOW = datetime(2026, 4, 19, tzinfo=UTC)


@pytest.mark.asyncio
async def test_fires_when_days_of_cover_below_lead_time(
    pg_pool, seed_shop, seed_reorder_timing_scenario
) -> None:
    await seed_shop(SHOP)
    # 4 days of cover, velocity 10/day, margin $20 ⇒
    # gap = 14 - 4 = 10 days ⇒ impact = 10 * 10 * 20 = $2000.
    await seed_reorder_timing_scenario(
        SHOP,
        days_of_cover=Decimal("4"),
        velocity_per_day=Decimal("10"),
        unit_margin_usd=Decimal("20"),
    )
    async with pg_pool.acquire() as conn:
        async with with_shop_context(conn, SHOP):
            results = await detect(SHOP, conn, NOW)

    assert len(results) == 1
    r = results[0]
    assert r.detector_id == "reorder_timing"
    assert r.dollar_impact == Decimal("2000.00")
    assert r.severity == "high"  # gap > 7 days


@pytest.mark.asyncio
async def test_threshold_defaults_to_200_when_no_override(
    pg_pool, seed_shop, seed_reorder_timing_scenario, monkeypatch
) -> None:
    """$200-default detector: offline gate is $200, not the $500 registry
    default. velocity 2/day, gap 10 days, margin $20 ⇒ impact $400 (between
    $200 and $500). MUST fire offline proving the gate is $200."""
    monkeypatch.delenv("MOAT_PEPPER", raising=False)
    await seed_shop(SHOP)
    await seed_reorder_timing_scenario(
        SHOP,
        days_of_cover=Decimal("4"),
        velocity_per_day=Decimal("2"),
        unit_margin_usd=Decimal("20"),
    )
    async with pg_pool.acquire() as conn:
        async with with_shop_context(conn, SHOP):
            results = await detect(SHOP, conn, NOW)
    assert len(results) == 1


@pytest.mark.asyncio
async def test_does_not_fire_when_above_lead_time(
    pg_pool, seed_shop, seed_reorder_timing_scenario
) -> None:
    await seed_shop(SHOP)
    # 30 days of cover ≥ 14-day lead time.
    await seed_reorder_timing_scenario(
        SHOP,
        days_of_cover=Decimal("30"),
        velocity_per_day=Decimal("10"),
        unit_margin_usd=Decimal("20"),
    )
    async with pg_pool.acquire() as conn:
        async with with_shop_context(conn, SHOP):
            results = await detect(SHOP, conn, NOW)

    assert results == []


@pytest.mark.asyncio
async def test_does_not_fire_when_velocity_zero(
    pg_pool, seed_shop, seed_reorder_timing_scenario
) -> None:
    await seed_shop(SHOP)
    # Below MIN_VELOCITY ⇒ not enough demand signal to act on.
    await seed_reorder_timing_scenario(
        SHOP,
        days_of_cover=Decimal("4"),
        velocity_per_day=Decimal("0"),
        unit_margin_usd=Decimal("20"),
    )
    async with pg_pool.acquire() as conn:
        async with with_shop_context(conn, SHOP):
            results = await detect(SHOP, conn, NOW)

    assert results == []
