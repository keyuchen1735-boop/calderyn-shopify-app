"""Plan 03 Task 25: per-shop alert threshold overrides.

Two scenarios:

1. No row in ``alert_thresholds`` → ``get_threshold`` falls back to the
   detector's registered default constant.
2. Row exists with the canonical key in its JSON payload →
   ``get_threshold`` returns that value as ``Decimal``.
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from calderyn_engine.db import with_shop_context
from calderyn_engine.thresholds import get_threshold

SHOP = "00000000-0000-0000-0000-0000000000e1"


@pytest.mark.asyncio
async def test_falls_back_to_default_when_no_row(pg_pool, seed_shop) -> None:
    await seed_shop(SHOP)
    async with pg_pool.acquire() as conn:
        async with with_shop_context(conn, SHOP):
            value = await get_threshold(
                conn, SHOP, "sku_stockout_vs_spend"
            )
    # Default for sku_stockout_vs_spend is $500 — same as the detector's
    # DEFAULT_THRESHOLD_USD module constant.
    assert value == Decimal("500")


@pytest.mark.asyncio
async def test_reads_override_from_table_when_row_exists(
    pg_pool, seed_shop
) -> None:
    await seed_shop(SHOP)
    async with pg_pool.acquire() as conn:
        async with with_shop_context(conn, SHOP):
            await conn.execute(
                """
                INSERT INTO alert_thresholds
                  (shop_id, detector_id, threshold_json)
                VALUES ($1::uuid, 'sku_stockout_vs_spend',
                        '{"min_spend_usd": 1000}'::jsonb)
                ON CONFLICT (shop_id, detector_id)
                DO UPDATE SET threshold_json = EXCLUDED.threshold_json
                """,
                SHOP,
            )
            value = await get_threshold(
                conn, SHOP, "sku_stockout_vs_spend"
            )
    assert value == Decimal("1000")


@pytest.mark.asyncio
async def test_unknown_detector_returns_zero_default(pg_pool, seed_shop) -> None:
    """Unknown detector_id with no DB row → ``Decimal("0")`` floor."""
    await seed_shop(SHOP)
    async with pg_pool.acquire() as conn:
        async with with_shop_context(conn, SHOP):
            value = await get_threshold(conn, SHOP, "no_such_detector")
    assert value == Decimal("0")


@pytest.mark.asyncio
async def test_moat_detection_models_overrides_alert_thresholds(
    pg_pool, seed_shop
) -> None:
    """Plan 05 Task 14 — when both layers carry a value for the same
    detector, the moat row wins because it's the trainer's freshest
    output. Seeds:

      * an alert_thresholds row at $1000
      * a moat.detection_models row at $2500
      * a corresponding moat_keys.shop_pseudonym mapping (so the
        pseudonym lookup matches what get_threshold computes)

    Expected: get_threshold returns $2500.
    """

    from calderyn_engine.moat.pseudonym import pseudonym_for

    pepper = "pepper-test-task-14"
    pseudonym = pseudonym_for(SHOP, pepper)

    await seed_shop(SHOP)
    async with pg_pool.acquire() as conn:
        async with with_shop_context(conn, SHOP):
            # Legacy alert_thresholds value (the layer-2 fallback).
            await conn.execute(
                """
                INSERT INTO alert_thresholds
                  (shop_id, detector_id, threshold_json)
                VALUES ($1::uuid, 'sku_stockout_vs_spend',
                        '{"min_spend_usd": 1000}'::jsonb)
                ON CONFLICT (shop_id, detector_id)
                DO UPDATE SET threshold_json = EXCLUDED.threshold_json
                """,
                SHOP,
            )
            # Trainer-written moat row (the layer-1 winner).
            await conn.execute(
                """
                INSERT INTO moat.detection_models
                  (detector_id, shop_id_pseudonym, threshold_json,
                   posterior_json)
                VALUES ('sku_stockout_vs_spend', $1,
                        '{"min_spend_usd": 2500}'::jsonb,
                        '{"alpha": 5.0, "beta": 1.0}'::jsonb)
                ON CONFLICT (detector_id, shop_id_pseudonym)
                DO UPDATE SET threshold_json = EXCLUDED.threshold_json,
                              posterior_json = EXCLUDED.posterior_json
                """,
                pseudonym,
            )
            value = await get_threshold(
                conn, SHOP, "sku_stockout_vs_spend", pepper=pepper
            )
    assert value == Decimal("2500")
