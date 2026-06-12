"""DB-gated tests for the campaign grade writer.

Needs a live Postgres via TEST_DATABASE_URL/DATABASE_URL; skipped otherwise
through the pg_pool fixture (same as the detector tests).

DAY adjustment note: seed_breakeven_scenario inserts ad_spend_fact with
``day = current_date`` and order_fact with ``created_at_source = now()``,
so the seeded rows always land on the DATABASE's *today* — which is UTC.
DAY must therefore be the UTC date, not the local one: with a local
``date.today()`` the suite fails every evening once UTC rolls past
midnight (e.g. after 8pm EDT) because the seeded spend lands one day
after the grading window ends.
"""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal

import pytest

from calderyn_engine.campaign_grade_repo import grade_campaigns_for_shop
from calderyn_engine.db import with_shop_context

SHOP = "00000000-0000-0000-0000-0000000000c1"
DAY = datetime.now(UTC).date()


@pytest.mark.asyncio
async def test_writes_poor_grade_for_below_breakeven_campaign(
    pg_pool, seed_shop, seed_breakeven_scenario
) -> None:
    await seed_shop(SHOP)
    await seed_breakeven_scenario(
        SHOP, spend=Decimal("1000"), revenue=Decimal("1200"), cogs=Decimal("700")
    )
    async with pg_pool.acquire() as conn:
        async with with_shop_context(conn, SHOP):
            graded = await grade_campaigns_for_shop(conn, SHOP, DAY, window_days=7)
            assert len(graded) == 1
            row = await conn.fetchrow(
                "select grade, confidence, spend_cents, revenue_cents "
                "from public.campaign_grade_fact where shop_id = $1::uuid",
                SHOP,
            )
    assert row["grade"] == "poor"
    assert row["confidence"] == "ok"
    assert row["spend_cents"] == 100000
    assert row["revenue_cents"] == 120000


@pytest.mark.asyncio
async def test_writes_winning_grade_for_profitable_campaign(
    pg_pool, seed_shop, seed_breakeven_scenario
) -> None:
    await seed_shop(SHOP)
    await seed_breakeven_scenario(
        SHOP, spend=Decimal("100"), revenue=Decimal("500"), cogs=Decimal("200")
    )
    async with pg_pool.acquire() as conn:
        async with with_shop_context(conn, SHOP):
            await grade_campaigns_for_shop(conn, SHOP, DAY, window_days=7)
            grade = await conn.fetchval(
                "select grade from public.campaign_grade_fact where shop_id=$1::uuid",
                SHOP,
            )
    assert grade == "winning"


@pytest.mark.asyncio
async def test_idempotent_on_campaign_day(
    pg_pool, seed_shop, seed_breakeven_scenario
) -> None:
    await seed_shop(SHOP)
    await seed_breakeven_scenario(
        SHOP, spend=Decimal("100"), revenue=Decimal("500"), cogs=Decimal("200")
    )
    async with pg_pool.acquire() as conn:
        async with with_shop_context(conn, SHOP):
            await grade_campaigns_for_shop(conn, SHOP, DAY, window_days=7)
            await grade_campaigns_for_shop(conn, SHOP, DAY, window_days=7)
            count = await conn.fetchval(
                "select count(*) from public.campaign_grade_fact where shop_id=$1::uuid",
                SHOP,
            )
    assert count == 1


@pytest.mark.asyncio
async def test_pipeline_writes_grades(
    pg_pool, seed_shop, seed_breakeven_scenario, monkeypatch
) -> None:
    """run_for_shop persists grades even when there are zero detections."""
    from calderyn_engine import pipeline
    from calderyn_engine.schemas import ClaudeOutput

    async def _fake_rank(detections, cfg, client=None):
        return ClaudeOutput(ranked=[])

    monkeypatch.setattr(pipeline, "rank_and_narrate", _fake_rank)

    await seed_shop(SHOP)
    # Profitable scenario -> no below-breakeven detection -> exercises the
    # "grades write even with zero detections" path.
    await seed_breakeven_scenario(
        SHOP, spend=Decimal("100"), revenue=Decimal("500"), cogs=Decimal("200")
    )
    await pipeline.run_for_shop(SHOP, day=DAY, pool=pg_pool)

    async with pg_pool.acquire() as conn:
        async with with_shop_context(conn, SHOP):
            count = await conn.fetchval(
                "select count(*) from public.campaign_grade_fact where shop_id=$1::uuid",
                SHOP,
            )
    assert count == 1
