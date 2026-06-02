"""Detector: cogs_drift.

Plan 03 Task 15b. Fires when the latest open ``cogs_fact`` entry diverges
by at least 10% from the prior cogs entry for the same SKU and the implied
30-day dollar exposure exceeds the threshold.

Plan 02's ``cogs_fact`` is an SCD2-style table: the current row has
``effective_to IS NULL``; the prior row has ``effective_to`` set to the
``effective_from`` of the current row. We pick the two most recent rows per
SKU via ``row_number()`` ordered by ``effective_from`` descending.
"""
from __future__ import annotations

from datetime import datetime
from decimal import Decimal

import asyncpg

from calderyn_engine.detectors import register
from calderyn_engine.schemas import DetectionResult

DETECTOR_ID = "cogs_drift"
MIN_DRIFT_PCT = Decimal("0.10")
DEFAULT_THRESHOLD_USD = Decimal("500")

_QUERY = """
WITH ranked_cogs AS (
  SELECT shop_id,
         sku_id,
         unit_cost_cents,
         effective_from,
         row_number() OVER (
           PARTITION BY shop_id, sku_id
           ORDER BY effective_from DESC
         ) AS rn
  FROM public.cogs_fact
  WHERE shop_id = $1
),
units_30d AS (
  SELECT ol.sku_id, sum(ol.quantity) AS units
  FROM public.order_line_fact ol
  JOIN public.order_fact o ON o.id = ol.order_id AND o.shop_id = ol.shop_id
  WHERE ol.shop_id = $1
    AND o.created_at_source >= (now() - interval '30 days')
  GROUP BY ol.sku_id
)
SELECT cur.sku_id,
       cur.unit_cost_cents AS current_cost_cents,
       prev.unit_cost_cents AS prior_cost_cents,
       coalesce(u.units, 0) AS units_30d,
       d.sku AS sku_code,
       d.title AS title
FROM ranked_cogs cur
JOIN ranked_cogs prev ON prev.sku_id = cur.sku_id AND prev.rn = 2
LEFT JOIN units_30d u ON u.sku_id = cur.sku_id
JOIN public.sku_dim d ON d.id = cur.sku_id
WHERE cur.rn = 1
  AND prev.unit_cost_cents > 0
  AND ((cur.unit_cost_cents - prev.unit_cost_cents)::numeric
        / NULLIF(prev.unit_cost_cents, 0)::numeric) >= $2
"""


@register(DETECTOR_ID)
async def detect(
    shop_id: str, conn: asyncpg.Connection, now: datetime
) -> list[DetectionResult]:
    rows = await conn.fetch(_QUERY, shop_id, MIN_DRIFT_PCT)
    out: list[DetectionResult] = []
    for r in rows:
        current_cents = Decimal(r["current_cost_cents"])
        prior_cents = Decimal(r["prior_cost_cents"])
        units = Decimal(r["units_30d"] or 0)
        delta_cents = current_cents - prior_cents
        impact = (delta_cents * units / Decimal(100)).quantize(Decimal("0.01"))
        if impact < DEFAULT_THRESHOLD_USD:
            continue
        drift_pct = delta_cents / prior_cents
        out.append(
            DetectionResult(
                detector_id=DETECTOR_ID,
                entity_ref={"sku_id": str(r["sku_id"]), "sku": r["sku_code"]},
                severity="high" if drift_pct >= Decimal("0.20") else "medium",
                dollar_impact=impact,
                evidence={
                    "prior_unit_cost_usd": str(
                        (prior_cents / Decimal(100)).quantize(Decimal("0.01"))
                    ),
                    "current_unit_cost_usd": str(
                        (current_cents / Decimal(100)).quantize(Decimal("0.01"))
                    ),
                    "drift_pct": str(drift_pct.quantize(Decimal("0.001"))),
                    "units_30d": int(units),
                    "title": r["title"],
                },
            )
        )
    return out
