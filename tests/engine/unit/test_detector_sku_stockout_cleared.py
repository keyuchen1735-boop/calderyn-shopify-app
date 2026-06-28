"""Detector ``sku_stockout_cleared`` (autopilot Slice B: auto-resume on
stockout-clear).

DB-gated tests — they need ``TEST_DATABASE_URL``/``DATABASE_URL`` set, and the
conftest ``pg_pool`` fixture skips them otherwise. They round-trip the real SQL
(the action_audit fork-#1 logic + the restock buffer) against Postgres.

The pure buffer/eligibility math is covered separately and without a DB in
engine/tests/test_sku_stockout_cleared.py.
"""

from __future__ import annotations

import itertools
import json
from datetime import datetime, UTC
from decimal import Decimal

import pytest

from calderyn_engine.db import with_shop_context
from calderyn_engine.detectors.sku_stockout_cleared import detect

SHOP = "00000000-0000-0000-0000-0000000000c1"
NOW = datetime(2026, 6, 27, tzinfo=UTC)

SKU_ID = "dddddddd-dddd-dddd-dddd-dddddddd1111"
LOCATION_ID = "dddddddd-dddd-dddd-dddd-dddddddd2222"
CAMPAIGN_ID = "dddddddd-dddd-dddd-dddd-dddddddd3333"
ALERT_ID = "dddddddd-dddd-dddd-dddd-dddddddd4444"

_SRC_SEQ = itertools.count(1)


def _cents(d: Decimal) -> int:
    return int((d * Decimal("100")).quantize(Decimal("1")))


def _source_version() -> int:
    return int(datetime.now(UTC).timestamp() * 1000) + next(_SRC_SEQ)


@pytest.fixture
def seed_stockout_cleared_scenario(pg_pool):
    """Seed a campaign Calderyn auto-paused for a stockout that is now restocked.

    Knobs let each test flip exactly one precondition:
      - ``stock_on_hand``     : current total on-hand (fork #2 buffer).
      - ``campaign_status``   : 'paused' (eligible) vs 'active' (merchant resumed).
      - ``actor``             : 'autopilot' (eligible) vs 'merchant' (fork #1).
      - ``pause_detector``    : the originating alert's detector_id (fork #1).
      - ``with_later_action`` : insert a newer action_audit row for the campaign
                                so the stockout pause is no longer the latest
                                action (merchant takeover, fork #1).
    """

    async def _seed(
        shop_id: str,
        *,
        stock_on_hand: int,
        velocity: Decimal = Decimal("10"),
        unit_margin: Decimal = Decimal("25"),
        prepause_spend_usd: Decimal = Decimal("900"),
        campaign_status: str = "paused",
        actor: str = "autopilot",
        pause_detector: str = "sku_stockout_vs_spend",
        with_later_action: bool = False,
    ) -> None:
        async with pg_pool.acquire() as conn:
            # Reset any rows on the fixed UUIDs from prior tests.
            await conn.execute("DELETE FROM public.action_audit WHERE shop_id = $1", shop_id)
            await conn.execute("DELETE FROM public.alert_context WHERE alert_id = $1", ALERT_ID)
            await conn.execute("DELETE FROM public.alerts WHERE id = $1", ALERT_ID)
            await conn.execute("DELETE FROM public.ad_spend_fact WHERE campaign_id = $1", CAMPAIGN_ID)
            await conn.execute("DELETE FROM public.ad_campaign_dim WHERE id = $1", CAMPAIGN_ID)
            await conn.execute("DELETE FROM public.sku_pnl WHERE sku_id = $1", SKU_ID)
            await conn.execute("DELETE FROM public.sku_velocity WHERE sku_id = $1", SKU_ID)
            await conn.execute(
                "DELETE FROM public.inventory_level_fact WHERE sku_id = $1 OR location_id = $2",
                SKU_ID,
                LOCATION_ID,
            )
            await conn.execute("DELETE FROM public.location_dim WHERE id = $1", LOCATION_ID)
            await conn.execute("DELETE FROM public.sku_dim WHERE id = $1", SKU_ID)

            await conn.execute(
                """
                INSERT INTO public.sku_dim
                  (id, shop_id, external_id, product_id, sku, title,
                   unit_cost_cents, currency)
                VALUES ($1, $2, 'ext-sc-1', 'prod-sc-1', 'SC-1',
                        'Stockout-Cleared SKU', 1000, 'USD')
                """,
                SKU_ID,
                shop_id,
            )
            await conn.execute(
                """
                INSERT INTO public.location_dim
                  (id, shop_id, external_id, name, country, region, active)
                VALUES ($1, $2, 'loc-sc', 'Main WH', 'US', 'CA', true)
                """,
                LOCATION_ID,
                shop_id,
            )
            await conn.execute(
                """
                INSERT INTO public.inventory_level_fact
                  (shop_id, sku_id, location_id, available, observed_at, source_version)
                VALUES ($1, $2, $3, $4, now(), $5)
                """,
                shop_id,
                SKU_ID,
                LOCATION_ID,
                stock_on_hand,
                _source_version(),
            )
            await conn.execute(
                """
                INSERT INTO public.sku_velocity
                  (shop_id, sku_id, location_id, window_days, units, computed_at)
                VALUES ($1, $2, NULL, 1, $3, now())
                """,
                shop_id,
                SKU_ID,
                velocity,
            )
            margin_cents_per_day = _cents(unit_margin * velocity)
            for day_offset in range(7):
                await conn.execute(
                    """
                    INSERT INTO public.sku_pnl
                      (shop_id, sku_id, day, revenue_cents, cogs_cents,
                       ad_spend_attrib_cents, return_cents, contribution_margin_cents)
                    VALUES ($1, $2, current_date - $3::int, $4, 0, 0, 0, $4)
                    ON CONFLICT (sku_id, day) DO UPDATE SET
                      contribution_margin_cents = EXCLUDED.contribution_margin_cents
                    """,
                    shop_id,
                    SKU_ID,
                    day_offset,
                    margin_cents_per_day,
                )
            await conn.execute(
                """
                INSERT INTO public.ad_campaign_dim
                  (id, shop_id, platform, external_id, name, status, currency)
                VALUES ($1, $2, 'meta', 'cmp_sc', 'Stockout-Cleared Campaign', $3, 'USD')
                """,
                CAMPAIGN_ID,
                shop_id,
                campaign_status,
            )
            # Pre-pause spend in the 7 days before the pause (paused 5 days ago,
            # so a spend row 7 days ago falls inside (paused_at-7d, paused_at]).
            await conn.execute(
                """
                INSERT INTO public.ad_spend_fact (shop_id, campaign_id, day, spend_cents)
                VALUES ($1, $2, current_date - 7, $3)
                """,
                shop_id,
                CAMPAIGN_ID,
                _cents(prepause_spend_usd),
            )
            # The originating stockout alert + its evidence (pause-time velocity).
            await conn.execute(
                """
                INSERT INTO public.alerts
                  (id, shop_id, detector_id, entity_ref, status, severity,
                   dollar_impact, day_bucket)
                VALUES ($1, $2, $3, $4::jsonb, 'resolved', 'high', 900,
                        current_date - 5)
                """,
                ALERT_ID,
                shop_id,
                pause_detector,
                json.dumps({"sku_id": SKU_ID, "sku": "SC-1"}),
            )
            await conn.execute(
                """
                INSERT INTO public.alert_context (alert_id, shop_id, evidence)
                VALUES ($1, $2, $3::jsonb)
                """,
                ALERT_ID,
                shop_id,
                json.dumps({"velocity_units_per_day": str(velocity)}),
            )
            # Calderyn's autopilot pause, 5 days ago.
            await conn.execute(
                """
                INSERT INTO public.action_audit
                  (shop_id, alert_id, action_kind, params, outcome, actor_user_id,
                   created_at)
                VALUES ($1, $2, 'pause_campaign', $3::jsonb, 'succeeded', $4,
                        now() - interval '5 days')
                """,
                shop_id,
                ALERT_ID,
                json.dumps({"campaign_id": CAMPAIGN_ID}),
                actor,
            )
            if with_later_action:
                # A newer action on the same campaign — merchant took it over.
                await conn.execute(
                    """
                    INSERT INTO public.action_audit
                      (shop_id, alert_id, action_kind, params, outcome,
                       actor_user_id, created_at)
                    VALUES ($1, NULL, 'reduce_campaign_budget', $2::jsonb,
                            'succeeded', 'merchant', now() - interval '1 day')
                    """,
                    shop_id,
                    json.dumps({"campaign_id": CAMPAIGN_ID}),
                )

    return _seed


async def _run(pg_pool, shop_id):
    async with pg_pool.acquire() as conn:
        async with with_shop_context(conn, shop_id):
            return await detect(shop_id, conn, NOW)


@pytest.mark.asyncio
async def test_fires_when_calderyn_paused_sku_restocked_above_buffer(
    pg_pool, seed_shop, seed_stockout_cleared_scenario
) -> None:
    await seed_shop(SHOP)
    # velocity 10 -> buffer 30; 60 units back in stock clears it.
    await seed_stockout_cleared_scenario(SHOP, stock_on_hand=60, velocity=Decimal("10"))
    results = await _run(pg_pool, SHOP)
    assert len(results) == 1
    r = results[0]
    assert r.detector_id == "sku_stockout_cleared"
    # entity_ref MUST carry campaign_id so v_autopilot_candidates resolves it.
    assert r.entity_ref["campaign_id"] == CAMPAIGN_ID
    assert r.entity_ref["sku_id"] == SKU_ID


@pytest.mark.asyncio
async def test_does_not_fire_when_stock_below_buffer(
    pg_pool, seed_shop, seed_stockout_cleared_scenario
) -> None:
    await seed_shop(SHOP)
    # velocity 10 -> buffer 30; only 12 units back -> still not enough.
    await seed_stockout_cleared_scenario(SHOP, stock_on_hand=12, velocity=Decimal("10"))
    assert await _run(pg_pool, SHOP) == []


@pytest.mark.asyncio
async def test_does_not_fire_when_campaign_already_active(
    pg_pool, seed_shop, seed_stockout_cleared_scenario
) -> None:
    await seed_shop(SHOP)
    # Merchant (or anything) already resumed the campaign -> nothing to resume.
    await seed_stockout_cleared_scenario(
        SHOP, stock_on_hand=60, campaign_status="active"
    )
    assert await _run(pg_pool, SHOP) == []


@pytest.mark.asyncio
async def test_does_not_fire_when_pause_was_not_autopilot(
    pg_pool, seed_shop, seed_stockout_cleared_scenario
) -> None:
    await seed_shop(SHOP)
    # The merchant paused it, not Calderyn -> fork #1 excludes it.
    await seed_stockout_cleared_scenario(SHOP, stock_on_hand=60, actor="merchant")
    assert await _run(pg_pool, SHOP) == []


@pytest.mark.asyncio
async def test_does_not_fire_when_pause_was_not_for_stockout(
    pg_pool, seed_shop, seed_stockout_cleared_scenario
) -> None:
    await seed_shop(SHOP)
    # Paused for a different detector -> not a stockout pause -> excluded.
    await seed_stockout_cleared_scenario(
        SHOP, stock_on_hand=60, pause_detector="campaign_below_breakeven"
    )
    assert await _run(pg_pool, SHOP) == []


@pytest.mark.asyncio
async def test_does_not_fire_when_merchant_took_over_after_pause(
    pg_pool, seed_shop, seed_stockout_cleared_scenario
) -> None:
    await seed_shop(SHOP)
    # A newer merchant action on the campaign means the stockout pause is no
    # longer the latest action -> fork #1 never overrides a merchant takeover.
    await seed_stockout_cleared_scenario(
        SHOP, stock_on_hand=60, with_later_action=True
    )
    assert await _run(pg_pool, SHOP) == []
