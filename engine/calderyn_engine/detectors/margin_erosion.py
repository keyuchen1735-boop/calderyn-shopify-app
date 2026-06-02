"""Detector: margin_erosion.

Plan 03 Task 15a. Fires when the unit margin computed over the last 7 days
has dropped at least 20% (configurable) below the prior 30-day baseline and
the implied dollar impact crosses the threshold.

Schema adaptation: Plan 02's ``sku_pnl`` aggregates contribution_margin in
cents per day and does not store unit_margin directly. We reconstruct
unit_margin from ``order_line_fact``: per window,
``unit_margin_cents = sum(price_cents * quantity - unit_cost_cents_snapshot * quantity) / sum(quantity)``.
"""
from __future__ import annotations

from datetime import datetime
from decimal import Decimal

import asyncpg

from calderyn_engine.detectors import register
from calderyn_engine.estimators.margin_erosion_loss import (
    estimate_margin_erosion_loss,
)
from calderyn_engine.schemas import DetectionResult

DETECTOR_ID = "margin_erosion"
DEFAULT_THRESHOLD_USD = Decimal("500")
MIN_DROP_PCT = Decimal("0.20")
MIN_BASELINE_UNITS = 20

_QUERY = """
WITH current_window AS (
  SELECT ol.sku_id,
         sum(ol.quantity)                                          AS units,
         sum(ol.price_cents * ol.quantity)::numeric
           / NULLIF(sum(ol.quantity), 0)                           AS avg_price_cents,
         sum(coalesce(ol.unit_cost_cents_snapshot, 0) * ol.quantity)::numeric
           / NULLIF(sum(ol.quantity), 0)                           AS avg_cost_cents
  FROM public.order_line_fact ol
  JOIN public.order_fact o ON o.id = ol.order_id AND o.shop_id = ol.shop_id
  WHERE ol.shop_id = $1
    AND o.created_at_source >= (now() - interval '7 days')
  GROUP BY ol.sku_id
),
baseline_window AS (
  SELECT ol.sku_id,
         sum(ol.quantity)                                          AS units,
         sum(ol.price_cents * ol.quantity)::numeric
           / NULLIF(sum(ol.quantity), 0)                           AS avg_price_cents,
         sum(coalesce(ol.unit_cost_cents_snapshot, 0) * ol.quantity)::numeric
           / NULLIF(sum(ol.quantity), 0)                           AS avg_cost_cents
  FROM public.order_line_fact ol
  JOIN public.order_fact o ON o.id = ol.order_id AND o.shop_id = ol.shop_id
  WHERE ol.shop_id = $1
    AND o.created_at_source <  (now() - interval '7 days')
    AND o.created_at_source >= (now() - interval '37 days')
  GROUP BY ol.sku_id
)
SELECT c.sku_id,
       c.units                                AS current_units,
       c.avg_price_cents                      AS current_price_cents,
       c.avg_cost_cents                       AS current_cost_cents,
       b.units                                AS baseline_units,
       b.avg_price_cents                      AS baseline_price_cents,
       b.avg_cost_cents                       AS baseline_cost_cents,
       d.sku                                  AS sku_code,
       d.title                                AS title
FROM current_window c
JOIN baseline_window b ON b.sku_id = c.sku_id
JOIN public.sku_dim d ON d.id = c.sku_id
WHERE b.units >= $2
  AND c.units > 0
"""


@register(DETECTOR_ID)
async def detect(
    shop_id: str, conn: asyncpg.Connection, now: datetime
) -> list[DetectionResult]:
    rows = await conn.fetch(_QUERY, shop_id, MIN_BASELINE_UNITS)
    out: list[DetectionResult] = []
    for r in rows:
        baseline_margin_cents = Decimal(r["baseline_price_cents"] or 0) - Decimal(
            r["baseline_cost_cents"] or 0
        )
        current_margin_cents = Decimal(r["current_price_cents"] or 0) - Decimal(
            r["current_cost_cents"] or 0
        )
        if baseline_margin_cents <= 0:
            continue
        delta = baseline_margin_cents - current_margin_cents
        drop_pct = delta / baseline_margin_cents
        if drop_pct < MIN_DROP_PCT:
            continue
        baseline_margin = baseline_margin_cents / Decimal(100)
        current_margin = current_margin_cents / Decimal(100)
        impact = estimate_margin_erosion_loss(
            units_sold=Decimal(r["current_units"]),
            baseline_unit_margin=baseline_margin,
            current_unit_margin=current_margin,
        )
        if impact < DEFAULT_THRESHOLD_USD:
            continue
        out.append(
            DetectionResult(
                detector_id=DETECTOR_ID,
                entity_ref={"sku_id": str(r["sku_id"]), "sku": r["sku_code"]},
                severity="high" if drop_pct >= Decimal("0.40") else "medium",
                dollar_impact=impact,
                evidence={
                    "baseline_unit_margin_usd": str(
                        baseline_margin.quantize(Decimal("0.01"))
                    ),
                    "current_unit_margin_usd": str(
                        current_margin.quantize(Decimal("0.01"))
                    ),
                    "drop_pct": str(drop_pct.quantize(Decimal("0.001"))),
                    "current_units_7d": int(r["current_units"]),
                    "baseline_units_30d": int(r["baseline_units"]),
                    "title": r["title"],
                },
            )
        )
    return out
