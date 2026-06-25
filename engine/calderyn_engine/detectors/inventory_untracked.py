"""Detector: a live product is not tracking inventory.

Catalog only — fires with zero orders. Flags active products whose variant has
Shopify inventory tracking off, so the merchant is flying blind on stock and
can oversell. dollar_impact 0, severity ``low`` (a hygiene nudge, not a loss).
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal

import asyncpg

from calderyn_engine.detectors import register
from calderyn_engine.schemas import DetectionResult

DETECTOR_ID = "inventory_untracked"

_QUERY = """
SELECT id AS sku_id, sku AS sku_code, title AS sku_title
FROM public.sku_dim
WHERE shop_id = $1
  AND inventory_tracked IS FALSE
  AND product_status = 'active'
"""


def untracked_result(sku_id, sku, title) -> DetectionResult:
    """Build the DetectionResult for one untracked live SKU (pure)."""
    return DetectionResult(
        detector_id=DETECTOR_ID,
        entity_ref={"sku_id": str(sku_id), "sku": sku},
        severity="low",
        dollar_impact=Decimal("0"),
        evidence={"sku_title": title},
    )


@register(DETECTOR_ID)
async def detect(
    shop_id: str, conn: asyncpg.Connection, now: datetime
) -> list[DetectionResult]:
    rows = await conn.fetch(_QUERY, shop_id)
    return [
        untracked_result(r["sku_id"], r["sku_code"], r["sku_title"]) for r in rows
    ]
