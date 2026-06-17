"""Slice #6 (tracer) — DB-backed proof that ``sku_stockout_vs_spend``
consumes the learned threshold from ``moat.detection_models`` via
``get_threshold``, closing the loop's CONSUME edge at the detector level.

Uses the ``pg_pool`` fixture (skips unless ``TEST_DATABASE_URL`` is a local
DB). Two obligations are discharged here:

* **Safe cutover** — with no ``moat.detection_models`` row and no
  ``MOAT_PEPPER``, the detector behaves byte-identically to the historical
  ``$500`` gate ($450 spend stays below the gate => no fire).
* **Loop closes at the detector** — inserting a ``detection_models`` row at
  a LOW ``min_spend_usd`` (keyed by the same pseudonym ``get_threshold``
  derives) lowers the gate so the SAME $450-spend scenario that did NOT fire
  at $500 now fires, and the resolved threshold the detector uses == 200.

Isolation: every test uses a random ``uuid.uuid4()`` shop_id so concurrent
test runs and the session-level truncate fixture cannot collide.
"""

from __future__ import annotations

import uuid
from datetime import datetime, UTC
from decimal import Decimal

import pytest

from calderyn_engine.db import with_shop_context
from calderyn_engine.detectors.sku_stockout_vs_spend import detect
from calderyn_engine.moat.pseudonym import pseudonym_for

DETECTOR = "sku_stockout_vs_spend"
NOW = datetime(2026, 4, 19, tzinfo=UTC)

# A spend that sits ABOVE the historical $200 gate but BELOW the $500 default,
# so the same scenario flips fire/no-fire purely on the resolved threshold.
SPEND_BETWEEN_200_AND_500 = Decimal("450")
LEARNED_MIN_SPEND = Decimal("200")


@pytest.mark.asyncio
async def test_no_model_row_is_byte_identical_to_500_default(
    pg_pool, seed_shop, seed_stockout_scenario, monkeypatch
) -> None:
    """Safe cutover: no MOAT_PEPPER, no detection_models row => the gate stays
    at the historical $500. A $450 stockout-spend scenario is below $500, so
    the detector must NOT fire — exactly as before get_threshold was threaded.
    """
    monkeypatch.delenv("MOAT_PEPPER", raising=False)
    shop_id = str(uuid.uuid4())
    await seed_shop(shop_id)
    await seed_stockout_scenario(
        shop_id,
        spend_usd=SPEND_BETWEEN_200_AND_500,
        stock_on_hand=0,
        velocity=Decimal("1"),
        unit_margin=Decimal("0"),  # estimator -> 0, impact falls back to spend
    )
    async with pg_pool.acquire() as conn:
        async with with_shop_context(conn, shop_id):
            results = await detect(shop_id, conn, NOW)
    assert results == []


@pytest.mark.asyncio
async def test_learned_model_row_lowers_gate_so_detector_fires(
    pg_pool, seed_shop, seed_stockout_scenario, monkeypatch
) -> None:
    """Loop closes at the detector: a moat.detection_models row at
    min_spend_usd=200 — keyed by the pseudonym get_threshold derives from
    MOAT_PEPPER — lowers the gate below the $450 spend, so the SAME scenario
    that did NOT fire at the $500 default now fires. Proves the learned value
    reaches detection.
    """
    pepper = "pepper-tracer-sku-stockout-consume"
    monkeypatch.setenv("MOAT_PEPPER", pepper)
    shop_id = str(uuid.uuid4())
    pseudonym = pseudonym_for(shop_id, pepper)

    await seed_shop(shop_id)
    await seed_stockout_scenario(
        shop_id,
        spend_usd=SPEND_BETWEEN_200_AND_500,
        stock_on_hand=0,
        velocity=Decimal("1"),
        unit_margin=Decimal("0"),
    )
    async with pg_pool.acquire() as conn:
        async with with_shop_context(conn, shop_id):
            await conn.execute(
                "DELETE FROM moat.detection_models "
                "WHERE detector_id = $1 AND shop_id_pseudonym = $2",
                DETECTOR,
                pseudonym,
            )
            await conn.execute(
                """
                INSERT INTO moat.detection_models
                  (detector_id, shop_id_pseudonym, threshold_json,
                   posterior_json)
                VALUES ($1, $2,
                        '{"min_spend_usd": 200}'::jsonb,
                        '{"alpha": 5.0, "beta": 1.0}'::jsonb)
                ON CONFLICT (detector_id, shop_id_pseudonym)
                DO UPDATE SET threshold_json = EXCLUDED.threshold_json,
                              posterior_json = EXCLUDED.posterior_json
                """,
                DETECTOR,
                pseudonym,
            )
            results = await detect(shop_id, conn, NOW)
    assert len(results) == 1
    assert results[0].detector_id == DETECTOR


@pytest.mark.asyncio
async def test_resolve_threshold_returns_learned_value_for_detector(
    pg_pool, seed_shop, monkeypatch
) -> None:
    """Direct assertion that the value the detector resolves is the learned
    200, not the $500 registry default — pins the consumed number itself."""
    from calderyn_engine.detectors._threshold import resolve_threshold
    from calderyn_engine.detectors.sku_stockout_vs_spend import (
        DEFAULT_THRESHOLD_USD,
    )

    pepper = "pepper-tracer-sku-stockout-resolve"
    monkeypatch.setenv("MOAT_PEPPER", pepper)
    shop_id = str(uuid.uuid4())
    pseudonym = pseudonym_for(shop_id, pepper)

    await seed_shop(shop_id)
    async with pg_pool.acquire() as conn:
        async with with_shop_context(conn, shop_id):
            await conn.execute(
                "DELETE FROM moat.detection_models "
                "WHERE detector_id = $1 AND shop_id_pseudonym = $2",
                DETECTOR,
                pseudonym,
            )
            await conn.execute(
                """
                INSERT INTO moat.detection_models
                  (detector_id, shop_id_pseudonym, threshold_json,
                   posterior_json)
                VALUES ($1, $2,
                        '{"min_spend_usd": 200}'::jsonb,
                        '{"alpha": 5.0, "beta": 1.0}'::jsonb)
                ON CONFLICT (detector_id, shop_id_pseudonym)
                DO UPDATE SET threshold_json = EXCLUDED.threshold_json,
                              posterior_json = EXCLUDED.posterior_json
                """,
                DETECTOR,
                pseudonym,
            )
            resolved = await resolve_threshold(
                conn, shop_id, DETECTOR, DEFAULT_THRESHOLD_USD
            )
    assert resolved == LEARNED_MIN_SPEND
    assert resolved != Decimal("500")
