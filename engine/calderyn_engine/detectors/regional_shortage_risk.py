"""Detector: regional_shortage_risk.

Plan 03 Task 17c. Fires when projected regional demand over the assumed
vendor lead time exceeds the in-region available stock.

Schema notes:
- ``location_dim.region`` is the canonical region label.
- Latest stock per (sku, location) is selected via ``DISTINCT ON``.
- ``DEFAULT_LEAD_TIME_DAYS`` is shared with ``reorder_timing`` because Plan
  02's ``sku_dim`` does not yet store a per-SKU lead time.
"""
from __future__ import annotations

from datetime import datetime
from decimal import Decimal

import asyncpg

from calderyn_engine.detectors import register
from calderyn_engine.detectors._threshold import resolve_threshold
from calderyn_engine.estimators.stockout_loss import estimate_stockout_loss
from calderyn_engine.schemas import DetectionResult

DETECTOR_ID = "regional_shortage_risk"
DEFAULT_LEAD_TIME_DAYS = Decimal("14")
DEFAULT_THRESHOLD_USD = Decimal("200")

_QUERY = """
WITH latest_inventory AS (
  SELECT DISTINCT ON (i.sku_id, i.location_id)
         i.sku_id,
         i.location_id,
         i.available
  FROM public.inventory_level_fact i
  WHERE i.shop_id = $1
  ORDER BY i.sku_id, i.location_id, i.observed_at DESC
),
regional_stock AS (
  SELECT li.sku_id, l.region, sum(li.available) AS qty
  FROM latest_inventory li
  JOIN public.location_dim l ON l.id = li.location_id
  GROUP BY li.sku_id, l.region
),
regional_demand AS (
  SELECT ol.sku_id, l.region, sum(ol.quantity)::numeric / 30.0 AS daily_demand
  FROM public.order_line_fact ol
  JOIN public.order_fact o ON o.id = ol.order_id AND o.shop_id = ol.shop_id
  JOIN public.fulfillment_fact f ON f.order_id = ol.order_id AND f.shop_id = ol.shop_id AND f.status = 'success'
  JOIN public.location_dim l ON l.id = f.location_id
  WHERE ol.shop_id = $1
    AND o.created_at_source >= (now() - interval '30 days')
  GROUP BY ol.sku_id, l.region
),
margin_proxy AS (
  SELECT ol.sku_id,
         (sum(ol.price_cents * ol.quantity)
           - sum(coalesce(ol.unit_cost_cents_snapshot, 0) * ol.quantity))::numeric
           / NULLIF(sum(ol.quantity), 0) AS unit_margin_cents
  FROM public.order_line_fact ol
  JOIN public.order_fact o ON o.id = ol.order_id AND o.shop_id = ol.shop_id
  WHERE ol.shop_id = $1
    AND o.created_at_source >= (now() - interval '30 days')
  GROUP BY ol.sku_id
)
SELECT rd.sku_id,
       rd.region,
       rd.daily_demand,
       coalesce(rs.qty, 0)              AS stock,
       coalesce(m.unit_margin_cents, 0) AS unit_margin_cents,
       d.sku                            AS sku_code,
       d.title                          AS title
FROM regional_demand rd
LEFT JOIN regional_stock rs ON rs.sku_id = rd.sku_id AND rs.region IS NOT DISTINCT FROM rd.region
LEFT JOIN margin_proxy m ON m.sku_id = rd.sku_id
JOIN public.sku_dim d ON d.id = rd.sku_id
WHERE rd.daily_demand > 0
  AND (rd.daily_demand * $2) > coalesce(rs.qty, 0)
"""


@register(DETECTOR_ID)
async def detect(
    shop_id: str, conn: asyncpg.Connection, now: datetime
) -> list[DetectionResult]:
    threshold = await resolve_threshold(
        conn, shop_id, DETECTOR_ID, DEFAULT_THRESHOLD_USD
    )
    rows = await conn.fetch(_QUERY, shop_id, DEFAULT_LEAD_TIME_DAYS)
    out: list[DetectionResult] = []
    for r in rows:
        daily_demand = Decimal(r["daily_demand"] or 0)
        stock = Decimal(r["stock"] or 0)
        if daily_demand <= 0:
            continue
        projected_need = daily_demand * DEFAULT_LEAD_TIME_DAYS
        shortfall_units = projected_need - stock
        if shortfall_units <= 0:
            continue
        shortfall_days = shortfall_units / daily_demand
        unit_margin_cents = Decimal(r["unit_margin_cents"] or 0)
        unit_margin_dollars = unit_margin_cents / Decimal(100)
        impact = estimate_stockout_loss(
            daily_velocity_units=daily_demand,
            stockout_days=shortfall_days,
            unit_margin=unit_margin_dollars,
        )
        if impact < threshold:
            continue
        out.append(
            DetectionResult(
                detector_id=DETECTOR_ID,
                entity_ref={
                    "sku_id": str(r["sku_id"]),
                    "region": r["region"],
                    "sku": r["sku_code"],
                },
                severity="high" if shortfall_days > 7 else "medium",
                dollar_impact=impact,
                evidence={
                    "daily_demand": str(daily_demand.quantize(Decimal("0.1"))),
                    "regional_stock_units": int(stock),
                    "lead_time_days": int(DEFAULT_LEAD_TIME_DAYS),
                    "shortfall_units": str(
                        shortfall_units.quantize(Decimal("0.1"))
                    ),
                    "title": r["title"],
                },
            )
        )
    return out
