"""Detector: a SKU's retail price is below its unit cost — a loss on every sale.

Catalog only — fires with zero orders. dollar_impact is the per-unit loss
(cost − price), shown by the UI as the row's money figure. Severity ``high``,
never ``critical`` (no realized bleed yet on a store with no sales).
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal

import asyncpg

from calderyn_engine.detectors import register
from calderyn_engine.detectors._margin import classify_margin, per_unit_loss_dollars
from calderyn_engine.schemas import DetectionResult

DETECTOR_ID = "priced_below_cost"
_THIN_PCT = Decimal("0.15")

_QUERY = """
SELECT id AS sku_id, sku AS sku_code, title AS sku_title,
       retail_price_cents, unit_cost_cents
FROM public.sku_dim
WHERE shop_id = $1
  AND retail_price_cents IS NOT NULL
  AND unit_cost_cents IS NOT NULL
  AND retail_price_cents > 0
"""


@register(DETECTOR_ID)
async def detect(
    shop_id: str, conn: asyncpg.Connection, now: datetime
) -> list[DetectionResult]:
    rows = await conn.fetch(_QUERY, shop_id)
    out: list[DetectionResult] = []
    for r in rows:
        price, cost = int(r["retail_price_cents"]), int(r["unit_cost_cents"])
        if classify_margin(price, cost, _THIN_PCT) != "below_cost":
            continue
        out.append(
            DetectionResult(
                detector_id=DETECTOR_ID,
                entity_ref={"sku_id": str(r["sku_id"]), "sku": r["sku_code"]},
                severity="high",
                dollar_impact=per_unit_loss_dollars(price, cost),
                evidence={
                    "sku_title": r["sku_title"],
                    "price_usd": str(Decimal(price) / Decimal("100")),
                    "cost_usd": str(Decimal(cost) / Decimal("100")),
                },
            )
        )
    return out
