# apps/engine/tests/integration/test_alerts_repo.py
"""Plan 03 Task 5: alerts repo upsert is idempotent and refreshes impact."""
from __future__ import annotations

import json
from decimal import Decimal

import pytest

from calderyn_engine.alerts_repo import upsert_alert
from calderyn_engine.db import with_shop_context
from calderyn_engine.schemas import AlertRow

SHOP = "00000000-0000-0000-0000-0000000000aa"


@pytest.mark.asyncio
async def test_upsert_alert_inserts_then_updates(pg_pool, seed_shop):
    await seed_shop(SHOP)
    row = AlertRow(
        shop_id=SHOP,
        detector_id="sku_stockout_vs_spend",
        entity_ref={"sku_id": "s1"},
        severity="high",
        dollar_impact=Decimal("500.00"),
        day_bucket="2026-04-19",
        evidence={"spend": 1000},
        claude_narrative=None,
        claude_rank=None,
    )
    async with pg_pool.acquire() as conn:
        async with with_shop_context(conn, SHOP):
            alert_id = await upsert_alert(conn, row)
            # Same key, new impact — must update not duplicate.
            row2 = row.model_copy(update={"dollar_impact": Decimal("750.00")})
            alert_id2 = await upsert_alert(conn, row2)
            assert alert_id == alert_id2

            got = await conn.fetchrow(
                "SELECT dollar_impact FROM alerts WHERE id = $1", alert_id
            )
            assert got["dollar_impact"] == Decimal("750.00")

            ctx = await conn.fetchrow(
                "SELECT evidence FROM alert_context WHERE alert_id = $1",
                alert_id,
            )
            # asyncpg returns jsonb as a JSON string by default; parse it
            # so the comparison is structural rather than textual.
            evidence = ctx["evidence"]
            if isinstance(evidence, str):
                evidence = json.loads(evidence)
            assert evidence == {"spend": 1000}
