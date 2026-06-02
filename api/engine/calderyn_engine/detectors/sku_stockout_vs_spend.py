"""Detector: a SKU is stocked out but ad spend is still flowing to it.

Plan 03 Task 10. Fires when, in the last 24 hours, total inventory across
locations for a SKU is at or below zero AND merchant-confirmed ad
spend mapped to that SKU over the trailing 7 days exceeds
``DEFAULT_THRESHOLD_USD``.

The detector uses ``estimate_stockout_loss`` to estimate lost gross profit
based on the SKU's daily velocity and unit margin. We treat the SKU as
having been stocked out for **one day** here because we have no precise
window from this query alone — the ``scaling_sku_fulfillment_risk``
detector refines forward-looking projections. If the velocity-driven
estimate is non-positive (e.g. no margin data), we fall back to the wasted
spend itself as the dollar impact, which is a strict lower bound on the
loss.

All money fields in Plan 02 are stored as ``*_cents integer``; we convert
to ``Decimal`` dollars at the SQL→Python boundary so callers see a
consistent unit at the API surface.
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal

import asyncpg

from calderyn_engine.detectors import register
from calderyn_engine.estimators.stockout_loss import estimate_stockout_loss
from calderyn_engine.schemas import DetectionResult

DETECTOR_ID = "sku_stockout_vs_spend"
DEFAULT_THRESHOLD_USD = Decimal("500")

# Translate Plan 03 column-fiction → Plan 02 reality:
#   * inventory_level_fact.as_of               → observed_at
#   * sku_velocity.daily_velocity_units        → units WHERE window_days = 1
#   * sku_pnl.unit_margin                      → derived from contribution_margin_cents / NULLIF(units, 0)
#   * ad_campaign_dim.connector                → platform
#   * ad_creative_sku_map.confirmed_by_merchant→ source IN ('merchant_confirmed','merchant_manual')
#   * ad_spend_fact.spend_usd                  → spend_cents (cents)
_QUERY = """
WITH stocked_out AS (
    SELECT sku_id, sum(available)::numeric AS qty
    FROM public.inventory_level_fact
    WHERE shop_id = $1
      AND observed_at >= now() - interval '24 hours'
    GROUP BY sku_id
    HAVING sum(available) <= 0
),
spend_last_7d AS (
    -- Plan 02 has no creative_id on ad_spend_fact and no campaign_id on
    -- ad_creative_sku_map, so we attribute spend at the (shop, platform)
    -- grain: every merchant-confirmed creative→sku map on a platform
    -- "claims" the spend of every campaign on that platform. That over-
    -- counts when multiple SKUs share platform spend, but it matches the
    -- granularity we have today; a future migration will add creative_id
    -- to ad_spend_fact and tighten this join.
    SELECT m.sku_id, sum(s.spend_cents)::numeric AS spend_cents
    FROM public.ad_spend_fact s
    JOIN public.ad_campaign_dim c
      ON c.id = s.campaign_id
     AND c.shop_id = s.shop_id
    JOIN public.ad_creative_sku_map m
      ON m.shop_id  = s.shop_id
     AND m.platform = c.platform
    WHERE s.shop_id = $1
      AND s.day >= (now() - interval '7 days')::date
      AND m.source IN ('merchant_confirmed', 'merchant_manual')
      AND m.sku_id IS NOT NULL
    GROUP BY m.sku_id
),
latest_velocity AS (
    SELECT DISTINCT ON (sku_id) sku_id, units
    FROM public.sku_velocity
    WHERE shop_id = $1
      AND window_days = 1
    ORDER BY sku_id, computed_at DESC
),
recent_pnl AS (
    SELECT sku_id,
           sum(contribution_margin_cents)::numeric AS margin_cents,
           sum(revenue_cents)::numeric             AS revenue_cents
    FROM public.sku_pnl
    WHERE shop_id = $1
      AND day >= (now() - interval '7 days')::date
    GROUP BY sku_id
)
SELECT so.sku_id,
       sp.spend_cents,
       coalesce(v.units, 0)::numeric AS velocity,
       coalesce(p.margin_cents, 0)::numeric  AS margin_cents_7d,
       coalesce(p.revenue_cents, 0)::numeric AS revenue_cents_7d,
       d.sku   AS sku_code,
       d.title AS sku_title
FROM stocked_out so
JOIN spend_last_7d sp ON sp.sku_id = so.sku_id
LEFT JOIN latest_velocity v ON v.sku_id = so.sku_id
LEFT JOIN recent_pnl     p ON p.sku_id = so.sku_id
LEFT JOIN public.sku_dim d ON d.id = so.sku_id
WHERE sp.spend_cents >= ($2 * 100)
"""


def _unit_margin_dollars(margin_cents: Decimal, velocity: Decimal) -> Decimal:
    """Approximate per-unit margin in dollars from a 7-day P&L slice.

    ``sku_pnl`` is a per-day aggregate, not per-unit, so we divide the
    7-day contribution margin by ``velocity_units_per_day * 7`` to get a
    per-unit estimate. Returns ``Decimal("0")`` when velocity is zero.
    """

    if velocity <= 0:
        return Decimal("0")
    units_7d = velocity * Decimal("7")
    return (margin_cents / Decimal("100") / units_7d) if units_7d > 0 else Decimal("0")


@register(DETECTOR_ID)
async def detect(
    shop_id: str, conn: asyncpg.Connection, now: datetime
) -> list[DetectionResult]:
    """Run the detector and return zero-or-more DetectionResult rows."""

    rows = await conn.fetch(_QUERY, shop_id, DEFAULT_THRESHOLD_USD)
    out: list[DetectionResult] = []
    for r in rows:
        spend_dollars = Decimal(r["spend_cents"]) / Decimal("100")
        velocity = Decimal(r["velocity"])
        unit_margin = _unit_margin_dollars(Decimal(r["margin_cents_7d"]), velocity)
        impact = estimate_stockout_loss(
            daily_velocity_units=velocity,
            stockout_days=Decimal("1"),
            unit_margin=unit_margin,
        )
        if impact <= 0:
            # Fall back to wasted spend as a strict lower bound on the loss.
            impact = spend_dollars
        severity = "critical" if spend_dollars >= DEFAULT_THRESHOLD_USD * 5 else "high"
        out.append(
            DetectionResult(
                detector_id=DETECTOR_ID,
                entity_ref={"sku_id": str(r["sku_id"]), "sku": r["sku_code"]},
                severity=severity,
                dollar_impact=impact,
                evidence={
                    "spend_7d_usd": str(spend_dollars),
                    "sku_title": r["sku_title"],
                    "velocity_units_per_day": str(velocity),
                    "unit_margin_usd": str(unit_margin),
                },
            )
        )
    return out
