"""Detector: ad spend hits a region whose local stock is empty while stock sits elsewhere.

Plan 03 Task 12. For each (sku, region) pair we compute trailing-7d ad
spend allocated to that region (campaigns whose ``geo_targets`` array
contains the region) and the current inventory in locations belonging to
that region. If the region is taking ``>= DEFAULT_SPEND_THRESHOLD`` USD
of merchant-confirmed spend but has zero stock locally, while there is
stock in other locations, the demand is being starved by allocation —
fire the alert.

The fix surface is a stock transfer (``reallocate_inventory`` action), so
we compute dollar impact via ``estimate_reallocation_gain``. Demand
shortfall is approximated as ``daily_velocity * 7`` capped at the total
units available elsewhere — we cannot transfer more than we have.

Plan 02 has no ``ad_spend_fact.geo`` column. Instead, geo lives on
``ad_campaign_dim.geo_targets`` (text[]). This detector treats a campaign
that targets a single region as fully attributable to that region; for
multi-region campaigns we fan out the spend evenly across targets.
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Any

import asyncpg

from calderyn_engine.detectors import register
from calderyn_engine.estimators.reallocation_gain import estimate_reallocation_gain
from calderyn_engine.schemas import DetectionResult

DETECTOR_ID = "regional_spend_starved_stock"
DEFAULT_SPEND_THRESHOLD = Decimal("500")
DEFAULT_TRANSFER_COST = Decimal("50")

# Translate Plan 03 column-fiction → Plan 02 reality:
#   * ad_spend_fact.geo                        → ad_campaign_dim.geo_targets text[] (campaign-level)
#   * ad_creative_sku_map.confirmed_by_merchant→ source IN ('merchant_confirmed','merchant_manual')
#   * ad_spend_fact.spend_usd                  → spend_cents (cents)
#   * sku_velocity.daily_velocity_units        → units WHERE window_days = 1
#   * sku_pnl.unit_margin                      → derived from contribution_margin_cents / 7d_units
#   * inventory_level_fact.as_of               → observed_at
#   * location_dim.region                      → exists; same name
_QUERY = """
WITH regional_spend AS (
    -- Fan-out: a campaign targeting N regions allocates spend/N to each.
    SELECT m.sku_id,
           geo                                       AS region,
           sum(s.spend_cents::numeric / NULLIF(array_length(c.geo_targets, 1), 0))::numeric AS spend_cents
    FROM public.ad_spend_fact s
    JOIN public.ad_campaign_dim c
      ON c.id = s.campaign_id
     AND c.shop_id = s.shop_id
    JOIN public.ad_creative_sku_map m
      ON m.shop_id  = s.shop_id
     AND m.platform = c.platform
    CROSS JOIN LATERAL unnest(c.geo_targets) AS geo
    WHERE s.shop_id = $1
      AND s.day >= (now() - interval '7 days')::date
      AND m.source IN ('merchant_confirmed', 'merchant_manual')
      AND m.sku_id IS NOT NULL
      AND array_length(c.geo_targets, 1) IS NOT NULL
    GROUP BY m.sku_id, geo
),
latest_inventory AS (
    SELECT DISTINCT ON (sku_id, location_id)
           sku_id, location_id, available, observed_at
    FROM public.inventory_level_fact
    WHERE shop_id = $1
    ORDER BY sku_id, location_id, observed_at DESC
),
regional_stock AS (
    SELECT li.sku_id, l.region, sum(li.available)::numeric AS qty
    FROM latest_inventory li
    JOIN public.location_dim l ON l.id = li.location_id
    WHERE l.region IS NOT NULL
    GROUP BY li.sku_id, l.region
),
total_stock AS (
    SELECT sku_id, sum(available)::numeric AS qty
    FROM latest_inventory
    GROUP BY sku_id
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
           sum(contribution_margin_cents)::numeric AS margin_cents
    FROM public.sku_pnl
    WHERE shop_id = $1
      AND day >= (now() - interval '7 days')::date
    GROUP BY sku_id
)
SELECT rs.sku_id,
       rs.region,
       rs.spend_cents,
       coalesce(rst.qty, 0)::numeric         AS regional_qty,
       coalesce(ts.qty, 0)::numeric          AS total_qty,
       coalesce(v.units, 0)::numeric         AS velocity,
       coalesce(p.margin_cents, 0)::numeric  AS margin_cents_7d,
       d.sku                                  AS sku_code,
       d.title                                AS sku_title,
       d.inventory_item_id                    AS inventory_item_id,
       dest.external_id                       AS to_location_external_id,
       src.external_id                        AS from_location_external_id,
       src.available                          AS from_location_available
FROM regional_spend rs
LEFT JOIN regional_stock rst ON rst.sku_id = rs.sku_id AND rst.region = rs.region
LEFT JOIN total_stock    ts  ON ts.sku_id  = rs.sku_id
LEFT JOIN latest_velocity v  ON v.sku_id   = rs.sku_id
LEFT JOIN recent_pnl     p   ON p.sku_id   = rs.sku_id
LEFT JOIN public.sku_dim d   ON d.id       = rs.sku_id
-- Destination of the transfer: an active location IN the starved region (the
-- region soaking up the ad spend). Deterministic pick keeps the alert stable
-- across re-runs so the same recommendation upserts in place.
LEFT JOIN LATERAL (
    SELECT l.external_id
    FROM public.location_dim l
    WHERE l.shop_id = $1
      AND l.region = rs.region
      AND l.active
    ORDER BY l.external_id
    LIMIT 1
) dest ON true
-- Source of the transfer: the location OUTSIDE the region holding the most of
-- this sku. A single inventoryAdjustQuantities call moves between exactly two
-- locations, so the recommended delta below is bounded by this one source.
LEFT JOIN LATERAL (
    SELECT l.external_id, li.available
    FROM latest_inventory li
    JOIN public.location_dim l ON l.id = li.location_id
    WHERE l.shop_id = $1
      AND li.sku_id = rs.sku_id
      AND l.region IS DISTINCT FROM rs.region
      AND li.available > 0
    ORDER BY li.available DESC, l.external_id
    LIMIT 1
) src ON true
WHERE rs.spend_cents >= ($2 * 100)
  AND coalesce(rst.qty, 0) <= 0
  AND (coalesce(ts.qty, 0) - coalesce(rst.qty, 0)) > 0
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

    rows = await conn.fetch(_QUERY, shop_id, DEFAULT_SPEND_THRESHOLD)
    out: list[DetectionResult] = []
    for r in rows:
        spend = Decimal(r["spend_cents"]) / Decimal("100")
        velocity = Decimal(r["velocity"])
        total_qty = Decimal(r["total_qty"])
        regional_qty = Decimal(r["regional_qty"])
        elsewhere_qty = total_qty - regional_qty
        unit_margin = _unit_margin_dollars(
            Decimal(r["margin_cents_7d"]), velocity
        )

        # Demand shortfall: a week of velocity, capped at what we could
        # actually transfer in (stock at non-regional locations).
        weekly_demand = velocity * Decimal("7")
        shortfall = min(weekly_demand, elsewhere_qty)
        impact = estimate_reallocation_gain(
            demand_shortfall_units=shortfall,
            unit_margin=unit_margin,
            transfer_cost=DEFAULT_TRANSFER_COST,
        )
        # If the estimator returns zero (e.g. no margin data), the
        # wasted-spend lower bound is still informative.
        if impact <= 0:
            impact = spend

        evidence: dict[str, Any] = {
            "region": r["region"],
            "regional_spend_7d_usd": str(spend),
            "regional_stock": int(regional_qty),
            "stock_elsewhere": int(elsewhere_qty),
            "velocity_units_per_day": str(velocity),
            "sku_title": r["sku_title"],
        }

        # Concrete transfer plan for the reallocate_inventory action. The alert
        # route replays these four fields verbatim into Shopify's
        # inventoryAdjustQuantities, so emit them ONLY when a real move exists:
        # a Shopify inventory item, an active destination location in the
        # starved region, and a source location elsewhere that holds stock.
        # When any piece is missing the fields stay absent and the route's
        # INVALID_INVENTORY_EVIDENCE guard fails the action visibly (rule 12)
        # rather than firing a malformed mutation.
        inv_item = r["inventory_item_id"]
        to_loc = r["to_location_external_id"]
        from_loc = r["from_location_external_id"]
        from_avail = r["from_location_available"]
        if inv_item and to_loc and from_loc and from_avail:
            recommended_delta = int(min(shortfall, Decimal(from_avail)))
            if recommended_delta > 0:
                evidence["inventory_item_id"] = inv_item
                evidence["from_location_id"] = from_loc
                evidence["to_location_id"] = to_loc
                evidence["recommended_delta"] = recommended_delta

        out.append(
            DetectionResult(
                detector_id=DETECTOR_ID,
                entity_ref={
                    "sku_id": str(r["sku_id"]),
                    "region": r["region"],
                    "sku": r["sku_code"],
                },
                severity="high",
                dollar_impact=impact,
                evidence=evidence,
            )
        )
    return out
