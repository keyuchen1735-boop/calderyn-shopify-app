"""Detector: wrong_location_concentration.

Plan 03 Task 17b. Fires when a single location holds at least 80% of a
SKU's total stock but the surrounding region accounts for less than 30% of
demand for that SKU. This pattern flags inventory that is parked far from
where customers actually buy from.

Schema notes:
- Plan 02 stores latest inventory in ``inventory_level_fact`` keyed by
  ``(sku_id, location_id, source_version)`` — we pick the most recent
  ``observed_at`` per (sku, location).
- ``location_dim.region`` is text (nullable). Demand share is computed from
  ``order_line_fact`` joined to ``fulfillment_fact`` to map order lines back
  to a fulfilling location and therefore a region.
"""
from __future__ import annotations

from datetime import datetime
from decimal import Decimal

import asyncpg

from calderyn_engine.detectors import register
from calderyn_engine.schemas import DetectionResult

DETECTOR_ID = "wrong_location_concentration"
STOCK_CONCENTRATION = Decimal("0.80")
DEMAND_SHARE_THRESHOLD = Decimal("0.30")
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
stock_total AS (
  SELECT sku_id, sum(available) AS total
  FROM latest_inventory
  GROUP BY sku_id
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
),
demand_by_region AS (
  SELECT ol.sku_id,
         l.region,
         sum(ol.quantity)::numeric AS units
  FROM public.order_line_fact ol
  JOIN public.order_fact o ON o.id = ol.order_id AND o.shop_id = ol.shop_id
  JOIN public.fulfillment_fact f ON f.order_id = ol.order_id AND f.shop_id = ol.shop_id AND f.status = 'success'
  JOIN public.location_dim l ON l.id = f.location_id
  WHERE ol.shop_id = $1
    AND o.created_at_source >= (now() - interval '30 days')
  GROUP BY ol.sku_id, l.region
),
demand_total AS (
  SELECT sku_id, sum(units) AS total FROM demand_by_region GROUP BY sku_id
)
SELECT li.sku_id,
       li.location_id,
       li.available                                   AS qty,
       (li.available::numeric / NULLIF(st.total, 0))  AS concentration,
       coalesce(dr.units, 0) / NULLIF(dt.total, 0)    AS demand_share,
       coalesce(m.unit_margin_cents, 0)               AS unit_margin_cents,
       l.region                                       AS region,
       d.sku                                          AS sku_code,
       d.title                                        AS title
FROM latest_inventory li
JOIN stock_total st ON st.sku_id = li.sku_id
JOIN public.location_dim l ON l.id = li.location_id
LEFT JOIN demand_by_region dr ON dr.sku_id = li.sku_id AND dr.region IS NOT DISTINCT FROM l.region
LEFT JOIN demand_total dt ON dt.sku_id = li.sku_id
LEFT JOIN margin_proxy m ON m.sku_id = li.sku_id
JOIN public.sku_dim d ON d.id = li.sku_id
WHERE st.total > 0
  AND (li.available::numeric / st.total) >= $2
  AND coalesce(coalesce(dr.units, 0) / NULLIF(dt.total, 0), 0) < $3
"""


@register(DETECTOR_ID)
async def detect(
    shop_id: str, conn: asyncpg.Connection, now: datetime
) -> list[DetectionResult]:
    rows = await conn.fetch(
        _QUERY, shop_id, STOCK_CONCENTRATION, DEMAND_SHARE_THRESHOLD
    )
    out: list[DetectionResult] = []
    for r in rows:
        qty = Decimal(r["qty"] or 0)
        unit_margin_cents = Decimal(r["unit_margin_cents"] or 0)
        unit_margin_dollars = unit_margin_cents / Decimal(100)
        # Carrying cost proxy: 10% of the locked margin held at the wrong loc.
        impact = (qty * unit_margin_dollars * Decimal("0.1")).quantize(
            Decimal("0.01")
        )
        if impact < DEFAULT_THRESHOLD_USD:
            continue
        concentration = Decimal(r["concentration"] or 0)
        demand_share = Decimal(r["demand_share"] or 0)
        out.append(
            DetectionResult(
                detector_id=DETECTOR_ID,
                entity_ref={
                    "sku_id": str(r["sku_id"]),
                    "location_id": str(r["location_id"]),
                    "region": r["region"],
                    "sku": r["sku_code"],
                },
                severity="medium",
                dollar_impact=impact,
                evidence={
                    "stock_concentration_pct": str(
                        (concentration * 100).quantize(Decimal("0.1"))
                    ),
                    "demand_share_pct": str(
                        (demand_share * 100).quantize(Decimal("0.1"))
                    ),
                    "location_region": r["region"],
                    "stock_units": int(qty),
                    "title": r["title"],
                },
            )
        )
    return out
