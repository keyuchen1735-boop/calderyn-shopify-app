"""Plan 03 Task 21: end-to-end pipeline integration test.

Seeds a small fixture that triggers exactly two detectors —
``sku_stockout_vs_spend`` and ``campaign_below_breakeven`` — drives the
pipeline against a mock Claude that returns a valid ClaudeOutput, and
checks:

1. Both detector_ids appear in the resulting ``alerts`` rows.
2. Each alert has a non-empty ``alert_context.evidence`` row.
3. Re-running the pipeline updates the same rows in place (no duplicates).
"""

from __future__ import annotations

import json
import os
from datetime import date
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import AsyncMock

import asyncpg
import pytest

from calderyn_engine.config import Config
from calderyn_engine.db import with_shop_context
from calderyn_engine.pipeline import run_for_shop

# Distinct from detector unit-test SHOP slots to avoid cross-test
# alert-row pollution.
SHOP = "00000000-0000-0000-0000-0000000000d1"


def _cfg() -> Config:
    url = os.environ.get("TEST_DATABASE_URL") or os.environ.get(
        "DATABASE_URL", ""
    )
    return Config(
        database_url=url,
        anthropic_api_key="test-key",
        env="test",
        claude_model="claude-opus-4-7",
    )


def _claude_output_for(entity_refs: list[tuple[str, dict]]) -> str:
    """Render a JSON ClaudeOutput covering the given (detector_id, entity_ref) pairs.

    The narratives are short, dollar-free, and verb-free so they pass
    every validator on :class:`ClaudeRankedItem`.
    """
    items = []
    for i, (detector_id, entity_ref) in enumerate(entity_refs):
        items.append(
            {
                "detector_id": detector_id,
                "entity_ref": entity_ref,
                "rank": i + 1,
                "narrative": (
                    "A condition has been observed that warrants merchant review."
                ),
            }
        )
    return json.dumps({"ranked": items})


def _mock_client_returning(payload_text: str) -> SimpleNamespace:
    block = SimpleNamespace(type="text", text=payload_text)
    response = SimpleNamespace(content=[block])
    messages = SimpleNamespace(create=AsyncMock(return_value=response))
    return SimpleNamespace(messages=messages)


@pytest.mark.asyncio
async def test_pipeline_writes_alerts_for_both_detectors(
    pg_pool: asyncpg.Pool,
    seed_shop,
    seed_stockout_scenario,
    seed_breakeven_scenario,
) -> None:
    """Two detectors fire → two alerts + two evidence rows."""

    await seed_shop(SHOP)
    await seed_stockout_scenario(
        SHOP,
        spend_usd=Decimal("900"),
        stock_on_hand=0,
        velocity=Decimal("8"),
        unit_margin=Decimal("30"),
    )
    await seed_breakeven_scenario(
        SHOP,
        spend=Decimal("1000"),
        revenue=Decimal("400"),
        cogs=Decimal("100"),
    )

    # We don't know the entity_refs the detectors will emit a priori
    # (UUIDs come from the fixture). The mock client returns a clean but
    # generic ClaudeOutput on the first call — an empty payload is still
    # a valid JSON document with an empty ``ranked`` array, which means
    # every alert ends up with no rank/narrative attached. That's fine
    # for this test: the assertions below check detector_id presence and
    # idempotency, not Claude pairing (covered in test_claude_layer).
    client = _mock_client_returning('{"ranked":[]}')

    upserted = await run_for_shop(
        SHOP,
        day=date(2026, 4, 19),
        cfg=_cfg(),
        claude_client=client,
        pool=pg_pool,
    )
    assert len(upserted) >= 2

    async with pg_pool.acquire() as conn:
        async with with_shop_context(conn, SHOP):
            rows = await conn.fetch(
                "SELECT id, detector_id FROM alerts WHERE shop_id = $1::uuid",
                SHOP,
            )
            ctx_rows = await conn.fetch(
                """
                SELECT alert_id, evidence
                FROM alert_context
                WHERE shop_id = $1::uuid
                """,
                SHOP,
            )

    detectors_fired = {r["detector_id"] for r in rows}
    assert "sku_stockout_vs_spend" in detectors_fired
    assert "campaign_below_breakeven" in detectors_fired

    # Each alert row has a corresponding alert_context row whose evidence
    # is a non-empty JSON object.
    ctx_by_id = {str(c["alert_id"]): c["evidence"] for c in ctx_rows}
    for r in rows:
        ev = ctx_by_id.get(str(r["id"]))
        assert ev is not None
        if isinstance(ev, str):
            ev = json.loads(ev)
        assert isinstance(ev, dict) and ev  # non-empty


@pytest.mark.asyncio
async def test_pipeline_is_idempotent_on_rerun(
    pg_pool: asyncpg.Pool,
    seed_shop,
    seed_stockout_scenario,
    seed_breakeven_scenario,
) -> None:
    """Running the pipeline twice on the same fixture upserts in place."""

    await seed_shop(SHOP)
    await seed_stockout_scenario(
        SHOP,
        spend_usd=Decimal("900"),
        stock_on_hand=0,
        velocity=Decimal("8"),
        unit_margin=Decimal("30"),
    )
    await seed_breakeven_scenario(
        SHOP,
        spend=Decimal("1000"),
        revenue=Decimal("400"),
        cogs=Decimal("100"),
    )

    client = _mock_client_returning('{"ranked":[]}')

    first = await run_for_shop(
        SHOP,
        day=date(2026, 4, 19),
        cfg=_cfg(),
        claude_client=client,
        pool=pg_pool,
    )
    second = await run_for_shop(
        SHOP,
        day=date(2026, 4, 19),
        cfg=_cfg(),
        claude_client=client,
        pool=pg_pool,
    )
    # Same set of alerts on both runs — same ids returned in the same
    # order, demonstrating the unique-key upsert path is hit, not insert.
    assert sorted(first) == sorted(second)

    async with pg_pool.acquire() as conn:
        async with with_shop_context(conn, SHOP):
            count = await conn.fetchval(
                "SELECT count(*) FROM alerts WHERE shop_id = $1::uuid",
                SHOP,
            )
    # Number of alert rows after rerun matches number on first run.
    assert count == len(first)
