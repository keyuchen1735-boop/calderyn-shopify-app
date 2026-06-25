"""Detector: a SKU's margin is positive but razor-thin (below 15%).

Catalog only — fires with zero orders. dollar_impact 0 (the risk is fragility,
not a current loss); the margin percent rides in evidence. Severity ``medium``.
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal, ROUND_HALF_UP

import asyncpg

from calderyn_engine.detectors import register
from calderyn_engine.detectors._margin import classify_margin
from calderyn_engine.schemas import DetectionResult

DETECTOR_ID = "thin_margin"
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


def thin_margin_result(sku_id, sku, title, price_cents, cost_cents) -> DetectionResult:
    """Build the DetectionResult for one thin-margin SKU (pure)."""
    margin_pct = (
        (Decimal(price_cents - cost_cents) / Decimal(price_cents) * Decimal("100"))
        .quantize(Decimal("1"), rounding=ROUND_HALF_UP)
    )
    return DetectionResult(
        detector_id=DETECTOR_ID,
        entity_ref={"sku_id": str(sku_id), "sku": sku},
        severity="medium",
        dollar_impact=Decimal("0"),
        evidence={
            "sku_title": title,
            "margin_pct": str(margin_pct),
            "price_usd": str(Decimal(price_cents) / Decimal("100")),
            "cost_usd": str(Decimal(cost_cents) / Decimal("100")),
        },
    )


@register(DETECTOR_ID)
async def detect(
    shop_id: str, conn: asyncpg.Connection, now: datetime
) -> list[DetectionResult]:
    rows = await conn.fetch(_QUERY, shop_id)
    out: list[DetectionResult] = []
    for r in rows:
        price, cost = int(r["retail_price_cents"]), int(r["unit_cost_cents"])
        if classify_margin(price, cost, _THIN_PCT) != "thin":
            continue
        out.append(
            thin_margin_result(r["sku_id"], r["sku_code"], r["sku_title"], price, cost)
        )
    return out
