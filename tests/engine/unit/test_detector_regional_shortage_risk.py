"""Unit tests for the ``regional_shortage_risk`` detector."""
from __future__ import annotations

from datetime import datetime, UTC
from decimal import Decimal

import pytest

from calderyn_engine.db import with_shop_context
from calderyn_engine.detectors.regional_shortage_risk import detect

SHOP = "00000000-0000-0000-0000-0000000000c2"
NOW = datetime(2026, 4, 19, tzinfo=UTC)


@pytest.mark.asyncio
async def test_fires_when_regional_demand_exceeds_stock(
    pg_pool, seed_shop, seed_regional_shortage_scenario
) -> None:
    await seed_shop(SHOP)
    # 300 units sold in CA over 30 days ⇒ 10/day. 14 * 10 = 140 projected
    # need; stock = 50 ⇒ shortfall 90 units / 10/day = 9 stockout days.
    # Margin $20 ⇒ impact = 10 * 9 * 20 = $1800.
    await seed_regional_shortage_scenario(
        SHOP,
        region="CA",
        regional_stock=50,
        units_30d=300,
        unit_margin_usd=Decimal("20"),
    )
    async with pg_pool.acquire() as conn:
        async with with_shop_context(conn, SHOP):
            results = await detect(SHOP, conn, NOW)

    assert len(results) == 1
    r = results[0]
    assert r.detector_id == "regional_shortage_risk"
    assert r.entity_ref["region"] == "CA"
    assert r.dollar_impact == Decimal("1800.00")


@pytest.mark.asyncio
async def test_threshold_defaults_to_200_when_no_override(
    pg_pool, seed_shop, seed_regional_shortage_scenario, monkeypatch
) -> None:
    """$200-default detector: offline gate is $200, not the $500 registry
    default. 150 units/30d = 5/day, stock 25, projected need 70, shortfall
    45 units / 9 days, impact = 5 * 9 * $10 = $450 (between $200 and $500).
    MUST fire offline proving the gate is $200."""
    monkeypatch.delenv("MOAT_PEPPER", raising=False)
    await seed_shop(SHOP)
    await seed_regional_shortage_scenario(
        SHOP,
        region="CA",
        regional_stock=25,
        units_30d=150,
        unit_margin_usd=Decimal("10"),
    )
    async with pg_pool.acquire() as conn:
        async with with_shop_context(conn, SHOP):
            results = await detect(SHOP, conn, NOW)
    assert len(results) == 1


@pytest.mark.asyncio
async def test_does_not_fire_when_stock_covers_lead_time(
    pg_pool, seed_shop, seed_regional_shortage_scenario
) -> None:
    await seed_shop(SHOP)
    # 30 units / 30 days = 1/day, 14-day need = 14 units, stock = 100 ⇒
    # no shortfall.
    await seed_regional_shortage_scenario(
        SHOP,
        region="CA",
        regional_stock=100,
        units_30d=30,
        unit_margin_usd=Decimal("20"),
    )
    async with pg_pool.acquire() as conn:
        async with with_shop_context(conn, SHOP):
            results = await detect(SHOP, conn, NOW)

    assert results == []


@pytest.mark.asyncio
async def test_does_not_fire_when_no_demand(
    pg_pool, seed_shop, seed_regional_shortage_scenario
) -> None:
    await seed_shop(SHOP)
    # No demand observed in CA region ⇒ no rows from regional_demand CTE ⇒
    # detector returns empty even though stock is also zero.
    await seed_regional_shortage_scenario(
        SHOP,
        region="CA",
        regional_stock=0,
        units_30d=0,
        unit_margin_usd=Decimal("20"),
    )
    async with pg_pool.acquire() as conn:
        async with with_shop_context(conn, SHOP):
            results = await detect(SHOP, conn, NOW)

    assert results == []
