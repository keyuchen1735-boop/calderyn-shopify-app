"""Unit tests for the ``return_rate_hidden_loss`` detector."""
from __future__ import annotations

from datetime import datetime, UTC
from decimal import Decimal

import pytest

from calderyn_engine.db import with_shop_context
from calderyn_engine.detectors.return_rate_hidden_loss import detect

SHOP = "00000000-0000-0000-0000-0000000000b5"
NOW = datetime(2026, 4, 19, tzinfo=UTC)


@pytest.mark.asyncio
async def test_fires_when_return_rate_above_baseline(
    pg_pool, seed_shop, seed_return_rate_scenario
) -> None:
    await seed_shop(SHOP)
    # 30% return rate is well above baseline (10%) + flag margin (5%).
    # Returns over 30d ≈ $900 ($30/day * 30); unit_cost $15, avg_price $50,
    # ⇒ returned_units ≈ 18 ⇒ impact ≈ 18 * $15 = $270 (>$200 threshold).
    await seed_return_rate_scenario(
        SHOP,
        return_rate=Decimal("0.30"),
    )
    async with pg_pool.acquire() as conn:
        async with with_shop_context(conn, SHOP):
            results = await detect(SHOP, conn, NOW)

    assert len(results) == 1
    r = results[0]
    assert r.detector_id == "return_rate_hidden_loss"
    assert r.severity == "high"
    assert r.dollar_impact > Decimal("200")


@pytest.mark.asyncio
async def test_does_not_fire_when_return_rate_normal(
    pg_pool, seed_shop, seed_return_rate_scenario
) -> None:
    await seed_shop(SHOP)
    await seed_return_rate_scenario(
        SHOP,
        return_rate=Decimal("0.05"),
    )
    async with pg_pool.acquire() as conn:
        async with with_shop_context(conn, SHOP):
            results = await detect(SHOP, conn, NOW)

    assert results == []


@pytest.mark.asyncio
async def test_does_not_fire_when_zero_returns(
    pg_pool, seed_shop, seed_return_rate_scenario
) -> None:
    await seed_shop(SHOP)
    await seed_return_rate_scenario(
        SHOP,
        return_rate=Decimal("0.00"),
    )
    async with pg_pool.acquire() as conn:
        async with with_shop_context(conn, SHOP):
            results = await detect(SHOP, conn, NOW)

    assert results == []
