"""Detector: reorder_timing.

Plan 03 Task 17a. Fires when a SKU's projected days-of-cover (from the most
recent ``stockout_forecast`` row) drops below the assumed vendor lead time
and there is implied stockout exposure.

Plan 02 schema gap: ``sku_dim`` has no ``lead_time_days`` column. We use a
module-level ``DEFAULT_LEAD_TIME_DAYS`` constant; later plans can replace
this with a per-SKU value sourced from a vendor table.

We compute unit_margin from the latest ``sku_pnl`` row:
``unit_margin_cents = contribution_margin_cents / NULLIF(units_sold_proxy, 0)``
where ``units_sold_proxy = revenue_cents / avg_price_cents``. To keep the
SQL small we use the most recent 7-day ``sku_pnl`` aggregate joined with the
average price from order lines.
"""
from __future__ import annotations

from datetime import datetime
from decimal import Decimal

import asyncpg

from calderyn_engine.detectors import register
from calderyn_engine.estimators.stockout_loss import estimate_stockout_loss
from calderyn_engine.schemas import DetectionResult

DETECTOR_ID = "reorder_timing"
DEFAULT_LEAD_TIME_DAYS = Decimal("14")
MIN_VELOCITY = Decimal("0.1")  # units/day floor to avoid divide-by-zero noise
DEFAULT_THRESHOLD_USD = Decimal("200")

_QUERY = """
WITH latest_forecast AS (
  SELECT DISTINCT ON (sku_id)
         sku_id,
         days_of_cover,
         computed_at
  FROM public.stockout_forecast
  WHERE shop_id = $1
  ORDER BY sku_id, computed_at DESC
),
latest_velocity AS (
  SELECT DISTINCT ON (sku_id)
         sku_id,
         units AS units_window7,
         window_days,
         computed_at
  FROM public.sku_velocity
  WHERE shop_id = $1
    AND window_days = 7
  ORDER BY sku_id, computed_at DESC
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
SELECT f.sku_id,
       f.days_of_cover,
       coalesce(v.units_window7, 0)              AS units_window7,
       coalesce(m.unit_margin_cents, 0)          AS unit_margin_cents,
       d.sku                                     AS sku_code,
       d.title                                   AS title
FROM latest_forecast f
LEFT JOIN latest_velocity v ON v.sku_id = f.sku_id
LEFT JOIN margin_proxy m ON m.sku_id = f.sku_id
JOIN public.sku_dim d ON d.id = f.sku_id
"""


@register(DETECTOR_ID)
async def detect(
    shop_id: str, conn: asyncpg.Connection, now: datetime
) -> list[DetectionResult]:
    rows = await conn.fetch(_QUERY, shop_id)
    out: list[DetectionResult] = []
    for r in rows:
        days_of_cover = Decimal(r["days_of_cover"])
        units_window7 = Decimal(r["units_window7"] or 0)
        velocity = units_window7 / Decimal("7")
        if velocity < MIN_VELOCITY:
            continue
        if days_of_cover >= DEFAULT_LEAD_TIME_DAYS:
            continue
        gap_days = DEFAULT_LEAD_TIME_DAYS - days_of_cover
        unit_margin_cents = Decimal(r["unit_margin_cents"] or 0)
        unit_margin_dollars = unit_margin_cents / Decimal(100)
        impact = estimate_stockout_loss(
            daily_velocity_units=velocity,
            stockout_days=gap_days,
            unit_margin=unit_margin_dollars,
        )
        if impact < DEFAULT_THRESHOLD_USD:
            continue
        out.append(
            DetectionResult(
                detector_id=DETECTOR_ID,
                entity_ref={"sku_id": str(r["sku_id"]), "sku": r["sku_code"]},
                severity="high" if gap_days > 7 else "medium",
                dollar_impact=impact,
                evidence={
                    "days_of_cover": str(
                        days_of_cover.quantize(Decimal("0.1"))
                    ),
                    "lead_time_days": int(DEFAULT_LEAD_TIME_DAYS),
                    "gap_days": str(gap_days.quantize(Decimal("0.1"))),
                    "daily_velocity_units": str(
                        velocity.quantize(Decimal("0.01"))
                    ),
                    "unit_margin_usd": str(
                        unit_margin_dollars.quantize(Decimal("0.01"))
                    ),
                    "title": r["title"],
                },
            )
        )
    return out
