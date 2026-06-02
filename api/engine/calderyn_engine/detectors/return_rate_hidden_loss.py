"""Detector: return_rate_hidden_loss.

Plan 03 Task 14. Fires when a SKU's return rate over the last 30 days is
materially above the storewide baseline (10%) and the implied COGS write-off
exceeds the dollar threshold.

Schema notes (Plan 02 has no ``order_line_fact.returned_quantity`` column):
returns are surfaced via ``sku_pnl.return_cents`` and ``sku_pnl.revenue_cents``;
the ratio of return dollars to revenue is the best return-rate proxy we have
without a dedicated refund fact table. Returned units are derived as
``return_cents / NULLIF(avg_price_cents, 0)`` using the per-SKU average order
line price over the same window.
"""
from __future__ import annotations

from datetime import datetime
from decimal import Decimal

import asyncpg

from calderyn_engine.detectors import register
from calderyn_engine.estimators.return_loss import estimate_return_loss
from calderyn_engine.schemas import DetectionResult

DETECTOR_ID = "return_rate_hidden_loss"
BASELINE_RETURN_RATE = Decimal("0.10")
FLAG_MARGIN = Decimal("0.05")  # 5 pct points above baseline
DEFAULT_THRESHOLD_USD = Decimal("200")
MIN_REVENUE_CENTS = 50_000  # ignore SKUs with < $500 revenue in window

_QUERY = """
WITH window_pnl AS (
  SELECT p.sku_id,
         sum(p.revenue_cents)             AS revenue_cents,
         sum(p.return_cents)              AS return_cents
  FROM public.sku_pnl p
  WHERE p.shop_id = $1
    AND p.day >= (current_date - interval '30 days')
  GROUP BY p.sku_id
),
window_lines AS (
  SELECT ol.sku_id,
         sum(ol.quantity)                                          AS units_sold,
         sum(ol.price_cents * ol.quantity)::numeric
           / NULLIF(sum(ol.quantity), 0)                           AS avg_price_cents,
         avg(coalesce(ol.unit_cost_cents_snapshot, 0))::numeric    AS avg_unit_cost_cents
  FROM public.order_line_fact ol
  JOIN public.order_fact o ON o.id = ol.order_id AND o.shop_id = ol.shop_id
  WHERE ol.shop_id = $1
    AND o.created_at_source >= (now() - interval '30 days')
  GROUP BY ol.sku_id
)
SELECT wp.sku_id,
       wp.revenue_cents,
       wp.return_cents,
       coalesce(wl.units_sold, 0)        AS units_sold,
       coalesce(wl.avg_price_cents, 0)   AS avg_price_cents,
       coalesce(wl.avg_unit_cost_cents, 0) AS avg_unit_cost_cents,
       d.sku                              AS sku_code,
       d.title                            AS title
FROM window_pnl wp
LEFT JOIN window_lines wl ON wl.sku_id = wp.sku_id
JOIN public.sku_dim d ON d.id = wp.sku_id
WHERE wp.revenue_cents >= $2
"""


@register(DETECTOR_ID)
async def detect(
    shop_id: str, conn: asyncpg.Connection, now: datetime
) -> list[DetectionResult]:
    rows = await conn.fetch(_QUERY, shop_id, MIN_REVENUE_CENTS)
    out: list[DetectionResult] = []
    for r in rows:
        revenue = Decimal(r["revenue_cents"])
        returns = Decimal(r["return_cents"] or 0)
        if revenue <= 0:
            continue
        rate = returns / revenue
        if rate < (BASELINE_RETURN_RATE + FLAG_MARGIN):
            continue
        avg_price_cents = Decimal(r["avg_price_cents"] or 0)
        avg_cost_cents = Decimal(r["avg_unit_cost_cents"] or 0)
        # Approximate returned units from return_cents / avg_price.
        if avg_price_cents <= 0:
            continue
        returned_units = returns / avg_price_cents
        unit_cost_dollars = avg_cost_cents / Decimal(100)
        impact = estimate_return_loss(
            returned_units=returned_units,
            unit_cost=unit_cost_dollars,
        )
        if impact < DEFAULT_THRESHOLD_USD:
            continue
        out.append(
            DetectionResult(
                detector_id=DETECTOR_ID,
                entity_ref={"sku_id": str(r["sku_id"]), "sku": r["sku_code"]},
                severity="high" if rate > Decimal("0.25") else "medium",
                dollar_impact=impact,
                evidence={
                    "return_rate": str(rate.quantize(Decimal("0.001"))),
                    "revenue_30d_usd": str(
                        (revenue / Decimal(100)).quantize(Decimal("0.01"))
                    ),
                    "return_30d_usd": str(
                        (returns / Decimal(100)).quantize(Decimal("0.01"))
                    ),
                    "units_sold_30d": int(r["units_sold"] or 0),
                    "title": r["title"],
                },
            )
        )
    return out
