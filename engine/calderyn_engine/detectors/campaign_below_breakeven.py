"""Detector: ad campaigns whose 7-day spend exceeded their attributed gross profit.

Plan 03 Task 11. For every active campaign we sum trailing-7d ad spend and
attributed gross profit (revenue − COGS). If spend > gross profit by at
least ``DEFAULT_THRESHOLD_USD``, the campaign is bleeding money and we
emit one DetectionResult.

Plan 02 stores no ``attribution_fact.attributed_cogs_cents`` column; we
derive COGS by joining attribution → order → order_line and summing
``unit_cost_cents_snapshot * quantity`` for each attributed order. This is
the COGS at time of order, snapshotted by the orders transformer.

All money fields are stored as ``*_cents integer``. We convert to
``Decimal`` dollars at the SQL→Python boundary.
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal

import asyncpg

from calderyn_engine.detectors import register
from calderyn_engine.estimators.below_breakeven_loss import (
    estimate_below_breakeven_loss,
)
from calderyn_engine.schemas import DetectionResult

DETECTOR_ID = "campaign_below_breakeven"
DEFAULT_THRESHOLD_USD = Decimal("500")

# Translate Plan 03 column-fiction → Plan 02 reality:
#   * ad_campaign_dim.connector                → platform
#   * ad_spend_fact.spend_usd                  → spend_cents (cents)
#   * attribution_fact.attributed_revenue_usd  → attributed_revenue_cents (cents)
#   * attribution_fact.attributed_cogs_usd     → DERIVED from order_line_fact
_QUERY = """
WITH spend_7d AS (
    SELECT s.campaign_id, sum(s.spend_cents)::numeric AS spend_cents
    FROM public.ad_spend_fact s
    WHERE s.shop_id = $1
      AND s.day >= (now() - interval '7 days')::date
    GROUP BY s.campaign_id
),
attributed_orders AS (
    SELECT a.campaign_id,
           sum(a.attributed_revenue_cents)::numeric AS revenue_cents,
           sum(coalesce(ol.unit_cost_cents_snapshot, 0) * ol.quantity)::numeric AS cogs_cents
    FROM public.attribution_fact a
    JOIN public.order_fact o
      ON o.id = a.order_id
     AND o.shop_id = a.shop_id
    LEFT JOIN public.order_line_fact ol
      ON ol.order_id = a.order_id
     AND ol.shop_id  = a.shop_id
    WHERE a.shop_id = $1
      AND a.campaign_id IS NOT NULL
      AND o.created_at_source >= now() - interval '7 days'
    GROUP BY a.campaign_id
)
SELECT c.id            AS campaign_id,
       c.name          AS campaign_name,
       c.platform      AS platform,
       coalesce(s.spend_cents, 0)::numeric    AS spend_cents,
       coalesce(a.revenue_cents, 0)::numeric  AS revenue_cents,
       coalesce(a.cogs_cents, 0)::numeric     AS cogs_cents
FROM public.ad_campaign_dim c
LEFT JOIN spend_7d         s ON s.campaign_id = c.id
LEFT JOIN attributed_orders a ON a.campaign_id = c.id
WHERE c.shop_id = $1
  AND c.status = 'active'
"""


@register(DETECTOR_ID)
async def detect(
    shop_id: str, conn: asyncpg.Connection, now: datetime
) -> list[DetectionResult]:
    """Run the detector and return zero-or-more DetectionResult rows."""

    rows = await conn.fetch(_QUERY, shop_id)
    out: list[DetectionResult] = []
    for r in rows:
        spend = Decimal(r["spend_cents"]) / Decimal("100")
        revenue = Decimal(r["revenue_cents"]) / Decimal("100")
        cogs = Decimal(r["cogs_cents"]) / Decimal("100")
        gross_profit = revenue - cogs
        impact = estimate_below_breakeven_loss(
            spend=spend, gross_profit=gross_profit
        )
        if impact < DEFAULT_THRESHOLD_USD:
            continue
        severity = (
            "critical" if impact >= DEFAULT_THRESHOLD_USD * 4 else "high"
        )
        out.append(
            DetectionResult(
                detector_id=DETECTOR_ID,
                entity_ref={
                    "campaign_id": str(r["campaign_id"]),
                    "platform": r["platform"],
                },
                severity=severity,
                dollar_impact=impact,
                evidence={
                    "campaign_name": r["campaign_name"],
                    "spend_7d_usd": str(spend),
                    "revenue_7d_usd": str(revenue),
                    "cogs_7d_usd": str(cogs),
                    "gross_profit_7d_usd": str(gross_profit),
                },
            )
        )
    return out
