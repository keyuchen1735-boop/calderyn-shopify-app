"""Detector: active products with no unit cost set (one shop-level nudge).

Catalog only — fires with zero orders. Without cost, the margin detectors
(and the order-based margin engine later) cannot protect the merchant, so this
is the activation nudge to fill costs in. One shop-scoped alert summarizing the
count, never one row per SKU. dollar_impact 0, severity ``low``.
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal

import asyncpg

from calderyn_engine.detectors import register
from calderyn_engine.schemas import DetectionResult

DETECTOR_ID = "missing_cost"

_QUERY = """
SELECT
    count(*) FILTER (WHERE unit_cost_cents IS NULL) AS missing,
    count(*) AS total
FROM public.sku_dim
WHERE shop_id = $1
  AND product_status = 'active'
"""


def missing_cost_result(count: int, total: int) -> DetectionResult | None:
    """Build the shop-level DetectionResult, or None when nothing is missing."""
    if count <= 0:
        return None
    return DetectionResult(
        detector_id=DETECTOR_ID,
        entity_ref={"scope": "shop"},
        severity="low",
        dollar_impact=Decimal("0"),
        evidence={"count": str(count), "total": str(total)},
    )


@register(DETECTOR_ID)
async def detect(
    shop_id: str, conn: asyncpg.Connection, now: datetime
) -> list[DetectionResult]:
    row = await conn.fetchrow(_QUERY, shop_id)
    result = missing_cost_result(int(row["missing"]), int(row["total"]))
    return [result] if result is not None else []
