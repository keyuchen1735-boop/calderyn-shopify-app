"""Unit tests for the ``negative_unit_economics`` detector."""
from __future__ import annotations

from datetime import datetime, UTC
from decimal import Decimal

import pytest

from calderyn_engine.db import with_shop_context
from calderyn_engine.detectors.negative_unit_economics import detect

SHOP = "00000000-0000-0000-0000-0000000000b9"
NOW = datetime(2026, 4, 19, tzinfo=UTC)


@pytest.mark.asyncio
async def test_fires_when_unit_econ_negative(
    pg_pool, seed_shop, seed_negative_unit_econ_scenario
) -> None:
    await seed_shop(SHOP)
    # 100 units at $20 price / $15 cost ⇒ unit margin $5.
    # $1000 spend across 100 units ⇒ CAC/unit $10.
    # Net = $5 - $10 = -$5 ⇒ impact 100 * $5 = $500.
    await seed_negative_unit_econ_scenario(
        SHOP,
        unit_price_usd=Decimal("20"),
        unit_cost_usd=Decimal("15"),
        units=100,
        spend_usd=Decimal("1000"),
    )
    async with pg_pool.acquire() as conn:
        async with with_shop_context(conn, SHOP):
            results = await detect(SHOP, conn, NOW)

    assert len(results) == 1
    r = results[0]
    assert r.detector_id == "negative_unit_economics"
    assert r.dollar_impact == Decimal("500.00")
    assert r.severity == "high"


@pytest.mark.asyncio
async def test_does_not_fire_when_unit_econ_positive(
    pg_pool, seed_shop, seed_negative_unit_econ_scenario
) -> None:
    await seed_shop(SHOP)
    # Margin $10, CAC $5 ⇒ net $5 (positive).
    await seed_negative_unit_econ_scenario(
        SHOP,
        unit_price_usd=Decimal("25"),
        unit_cost_usd=Decimal("15"),
        units=100,
        spend_usd=Decimal("500"),
    )
    async with pg_pool.acquire() as conn:
        async with with_shop_context(conn, SHOP):
            results = await detect(SHOP, conn, NOW)

    assert results == []


@pytest.mark.asyncio
async def test_does_not_fire_below_threshold(
    pg_pool, seed_shop, seed_negative_unit_econ_scenario
) -> None:
    await seed_shop(SHOP)
    # Net per unit -$1 across only 10 units ⇒ impact $10, below $500.
    await seed_negative_unit_econ_scenario(
        SHOP,
        unit_price_usd=Decimal("20"),
        unit_cost_usd=Decimal("19"),
        units=10,
        spend_usd=Decimal("20"),
    )
    async with pg_pool.acquire() as conn:
        async with with_shop_context(conn, SHOP):
            results = await detect(SHOP, conn, NOW)

    assert results == []
