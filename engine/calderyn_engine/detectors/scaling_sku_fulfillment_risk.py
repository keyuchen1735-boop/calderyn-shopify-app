"""Detector: a SKU is scaling fast and projected to stock out soon.

Plan 03 Task 13. Combines two signals:

1. **Forward-looking cover.** ``stockout_forecast.days_of_cover`` from the
   most recent computation must be below ``DAYS_OF_COVER_THRESHOLD``.
2. **Spend trend.** Trailing-7-day spend on merchant-confirmed campaigns
   mapped to the SKU is at least ``SPEND_TREND_THRESHOLD`` ×
   the prior 7-day spend (i.e. ad investment is climbing).

Together these mean: we are pouring money into a SKU and we will run out
before the orders we've already paid to acquire can be filled.

Dollar impact estimates the gross profit lost during the projected
stockout window using ``estimate_stockout_loss`` with
``stockout_days = max(0, 7 - days_of_cover)``.
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal

import asyncpg

from calderyn_engine.detectors import register
from calderyn_engine.estimators.stockout_loss import estimate_stockout_loss
from calderyn_engine.schemas import DetectionResult

DETECTOR_ID = "scaling_sku_fulfillment_risk"
DAYS_OF_COVER_THRESHOLD = Decimal("5")
SPEND_TREND_THRESHOLD = Decimal("1.5")  # spend_this_7d / spend_prev_7d

# Translate Plan 03 column-fiction → Plan 02 reality:
#   * sku_velocity.daily_velocity_units        → units WHERE window_days = 1
#   * sku_pnl.unit_margin                      → derived from contribution_margin_cents / 7d_units
#   * ad_creative_sku_map.confirmed_by_merchant→ source IN ('merchant_confirmed','merchant_manual')
#   * ad_spend_fact.spend_usd                  → spend_cents (cents)
#   * stockout_forecast.days_of_cover          → exists in Plan 02 cogs_and_derived migration
_QUERY = """
WITH latest_forecast AS (
    SELECT DISTINCT ON (sku_id) sku_id, days_of_cover
    FROM public.stockout_forecast
    WHERE shop_id = $1
    ORDER BY sku_id, computed_at DESC
),
latest_velocity AS (
    SELECT DISTINCT ON (sku_id) sku_id, units
    FROM public.sku_velocity
    WHERE shop_id = $1
      AND window_days = 1
    ORDER BY sku_id, computed_at DESC
),
spend_wow AS (
    SELECT m.sku_id,
           coalesce(sum(CASE WHEN s.day >= (now() - interval '7 days')::date
                              THEN s.spend_cents END), 0)::numeric AS spend_this_cents,
           coalesce(sum(CASE WHEN s.day BETWEEN (now() - interval '14 days')::date
                                            AND (now() - interval '8 days')::date
                              THEN s.spend_cents END), 0)::numeric AS spend_prev_cents
    FROM public.ad_spend_fact s
    JOIN public.ad_campaign_dim c
      ON c.id = s.campaign_id
     AND c.shop_id = s.shop_id
    JOIN public.ad_creative_sku_map m
      ON m.shop_id  = s.shop_id
     AND m.platform = c.platform
    WHERE s.shop_id = $1
      AND m.source IN ('merchant_confirmed', 'merchant_manual')
      AND m.sku_id IS NOT NULL
    GROUP BY m.sku_id
),
recent_pnl AS (
    SELECT sku_id,
           sum(contribution_margin_cents)::numeric AS margin_cents
    FROM public.sku_pnl
    WHERE shop_id = $1
      AND day >= (now() - interval '7 days')::date
    GROUP BY sku_id
),
sku_stock AS (
    SELECT sku_id, sum(available)::numeric AS qty
    FROM public.inventory_level_fact
    WHERE shop_id = $1
    GROUP BY sku_id
)
SELECT lf.sku_id,
       lf.days_of_cover,
       coalesce(v.units, 0)::numeric        AS velocity,
       coalesce(ss.qty, 0)::numeric         AS stock,
       coalesce(p.margin_cents, 0)::numeric AS margin_cents_7d,
       coalesce(sw.spend_this_cents, 0)::numeric AS spend_this_cents,
       coalesce(sw.spend_prev_cents, 0)::numeric AS spend_prev_cents,
       d.sku   AS sku_code,
       d.title AS sku_title
FROM latest_forecast lf
LEFT JOIN latest_velocity v  ON v.sku_id  = lf.sku_id
LEFT JOIN spend_wow      sw  ON sw.sku_id = lf.sku_id
LEFT JOIN recent_pnl     p   ON p.sku_id  = lf.sku_id
LEFT JOIN sku_stock      ss  ON ss.sku_id = lf.sku_id
LEFT JOIN public.sku_dim d   ON d.id      = lf.sku_id
WHERE lf.days_of_cover < $2
  AND coalesce(sw.spend_prev_cents, 0) > 0
  AND (coalesce(sw.spend_this_cents, 0) / NULLIF(sw.spend_prev_cents, 0)) >= $3
  AND coalesce(v.units, 0) > 0
"""


def _unit_margin_dollars(margin_cents: Decimal, velocity: Decimal) -> Decimal:
    """Approximate per-unit margin in dollars from a 7-day P&L slice."""

    if velocity <= 0:
        return Decimal("0")
    units_7d = velocity * Decimal("7")
    return (margin_cents / Decimal("100") / units_7d) if units_7d > 0 else Decimal("0")


@register(DETECTOR_ID)
async def detect(
    shop_id: str, conn: asyncpg.Connection, now: datetime
) -> list[DetectionResult]:
    """Run the detector and return zero-or-more DetectionResult rows."""

    rows = await conn.fetch(
        _QUERY, shop_id, DAYS_OF_COVER_THRESHOLD, SPEND_TREND_THRESHOLD
    )
    out: list[DetectionResult] = []
    for r in rows:
        velocity = Decimal(r["velocity"])
        days_of_cover = Decimal(r["days_of_cover"])
        spend_this = Decimal(r["spend_this_cents"]) / Decimal("100")
        spend_prev = Decimal(r["spend_prev_cents"]) / Decimal("100")
        unit_margin = _unit_margin_dollars(
            Decimal(r["margin_cents_7d"]), velocity
        )

        projected_stockout_days = max(
            Decimal("7") - days_of_cover, Decimal("0")
        )
        impact = estimate_stockout_loss(
            daily_velocity_units=velocity,
            stockout_days=projected_stockout_days,
            unit_margin=unit_margin,
        )
        if impact <= 0:
            # Without margin data we still surface the alert at the
            # spend-loss lower bound — this is the merchant's exposure if
            # all forecasted demand is unfulfilled.
            impact = spend_this

        severity = "critical" if days_of_cover < Decimal("2") else "high"
        wow_ratio = (
            (spend_this / spend_prev).quantize(Decimal("0.01"))
            if spend_prev > 0
            else Decimal("0")
        )

        out.append(
            DetectionResult(
                detector_id=DETECTOR_ID,
                entity_ref={"sku_id": str(r["sku_id"]), "sku": r["sku_code"]},
                severity=severity,
                dollar_impact=impact,
                evidence={
                    "days_of_cover": str(days_of_cover.quantize(Decimal("0.1"))),
                    "velocity_units_per_day": str(velocity),
                    "stock": int(Decimal(r["stock"])),
                    "spend_wow_ratio": str(wow_ratio),
                    "spend_this_7d_usd": str(spend_this),
                    "spend_prev_7d_usd": str(spend_prev),
                    "sku_title": r["sku_title"],
                },
            )
        )
    return out
