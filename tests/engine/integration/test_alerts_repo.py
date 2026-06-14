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


@pytest.mark.asyncio
async def test_upsert_alert_dedupes_across_days(pg_pool, seed_shop):
    """A still-true condition re-detected on a LATER day must refresh the same
    open alert, not mint a second one.

    Regression for the alert pile-up: the old conflict key included
    ``day_bucket``, so each new UTC day inserted a fresh open alert for the
    same ongoing condition and the prior day's never resolved — open alerts
    grew one-per-day-per-condition without bound.
    """
    shop = "00000000-0000-0000-0000-0000000000bb"
    await seed_shop(shop)
    base = AlertRow(
        shop_id=shop,
        detector_id="negative_unit_economics",
        entity_ref={"sku_id": "pileup-sku"},
        severity="high",
        dollar_impact=Decimal("100.00"),
        day_bucket="2026-06-09",
        evidence={"day": 1},
        claude_narrative=None,
        claude_rank=None,
    )
    async with pg_pool.acquire() as conn:
        async with with_shop_context(conn, shop):
            id_day1 = await upsert_alert(conn, base)
            # Next day, same condition, drifted impact.
            id_day2 = await upsert_alert(
                conn,
                base.model_copy(
                    update={
                        "day_bucket": "2026-06-10",
                        "dollar_impact": Decimal("150.00"),
                    }
                ),
            )
            assert id_day1 == id_day2  # one row across days, not a duplicate

            rows = await conn.fetch(
                "SELECT day_bucket, dollar_impact, status FROM alerts "
                "WHERE shop_id = $1 AND detector_id = $2",
                shop,
                "negative_unit_economics",
            )
            assert len(rows) == 1
            assert rows[0]["status"] == "open"
            assert str(rows[0]["day_bucket"]) == "2026-06-10"  # bumped forward
            assert rows[0]["dollar_impact"] == Decimal("150.00")


@pytest.mark.asyncio
async def test_upsert_alert_reopens_after_resolution(pg_pool, seed_shop):
    """Once an alert is resolved, the same condition recurring opens a FRESH
    alert — terminal rows sit outside the active-condition unique index, so a
    recurrence is a new problem, not a silent refresh of the closed one.
    """
    shop = "00000000-0000-0000-0000-0000000000cc"
    await seed_shop(shop)
    row = AlertRow(
        shop_id=shop,
        detector_id="reorder_timing",
        entity_ref={"sku_id": "recur-sku"},
        severity="medium",
        dollar_impact=Decimal("50.00"),
        day_bucket="2026-06-09",
        evidence={},
        claude_narrative=None,
        claude_rank=None,
    )
    async with pg_pool.acquire() as conn:
        async with with_shop_context(conn, shop):
            first = await upsert_alert(conn, row)
            await conn.execute(
                "UPDATE alerts SET status='resolved', resolved_at=now() "
                "WHERE id = $1",
                first,
            )
            second = await upsert_alert(
                conn, row.model_copy(update={"day_bucket": "2026-06-12"})
            )
            assert second != first  # a new alert, not a refresh of the resolved one

            count = await conn.fetchval(
                "SELECT count(*) FROM alerts WHERE shop_id = $1 AND detector_id = $2",
                shop,
                "reorder_timing",
            )
            assert count == 2  # one resolved (history), one fresh open


@pytest.mark.asyncio
async def test_upsert_alert_reopens_acknowledged_condition(pg_pool, seed_shop):
    """A still-true condition whose alert was acknowledged must be re-opened by
    the detector on the next pass.

    Contract (app/lib/alerts.server.ts): acknowledge moves an alert out of the
    open queue after the merchant acts, but "the detector still owns resolution
    and may re-open it." Without this, an acknowledged-but-still-firing problem
    silently stays hidden while it keeps losing money.
    """
    shop = "00000000-0000-0000-0000-0000000000dd"
    await seed_shop(shop)
    row = AlertRow(
        shop_id=shop,
        detector_id="ad_tax_overload",
        entity_ref={"sku_id": "ack-sku"},
        severity="high",
        dollar_impact=Decimal("80.00"),
        day_bucket="2026-06-09",
        evidence={},
        claude_narrative=None,
        claude_rank=None,
    )
    async with pg_pool.acquire() as conn:
        async with with_shop_context(conn, shop):
            aid = await upsert_alert(conn, row)
            await conn.execute(
                "UPDATE alerts SET status = 'acknowledged' WHERE id = $1", aid
            )
            # Condition persists into the next day → detector re-fires.
            aid2 = await upsert_alert(
                conn, row.model_copy(update={"day_bucket": "2026-06-10"})
            )
            assert aid2 == aid  # same row refreshed, not a duplicate
            got = await conn.fetchrow(
                "SELECT status, day_bucket FROM alerts WHERE id = $1", aid
            )
            assert got["status"] == "open"  # re-opened for the merchant
            assert str(got["day_bucket"]) == "2026-06-10"


@pytest.mark.asyncio
async def test_upsert_alert_preserves_snooze(pg_pool, seed_shop):
    """A snoozed alert stays snoozed when the detector re-fires — snooze is a
    deliberate timed deferral (cleared by its deadline / next login), not by
    detection — even though its impact/narrative refresh in place.
    """
    shop = "00000000-0000-0000-0000-0000000000ee"
    await seed_shop(shop)
    row = AlertRow(
        shop_id=shop,
        detector_id="margin_erosion",
        entity_ref={"sku_id": "snz-sku"},
        severity="medium",
        dollar_impact=Decimal("40.00"),
        day_bucket="2026-06-09",
        evidence={},
        claude_narrative=None,
        claude_rank=None,
    )
    async with pg_pool.acquire() as conn:
        async with with_shop_context(conn, shop):
            aid = await upsert_alert(conn, row)
            await conn.execute(
                "UPDATE alerts SET status = 'snoozed' WHERE id = $1", aid
            )
            aid2 = await upsert_alert(
                conn,
                row.model_copy(
                    update={
                        "day_bucket": "2026-06-10",
                        "dollar_impact": Decimal("999.00"),
                    }
                ),
            )
            assert aid2 == aid  # refreshed in place, not duplicated
            got = await conn.fetchrow(
                "SELECT status, dollar_impact FROM alerts WHERE id = $1", aid
            )
            assert got["status"] == "snoozed"  # snooze preserved
            assert got["dollar_impact"] == Decimal("999.00")  # content refreshed
