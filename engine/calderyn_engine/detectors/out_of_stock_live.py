"""Detector: a live (published) product is out of stock and cannot be sold.

Catalog/inventory only — fires with zero orders. Sums the latest observed
``available`` per (sku, location) for tracked variants of active products and
flags any SKU whose total is at or below zero. dollar_impact is 0: with no
sales history there is no realized loss to claim, so the finding is an
opportunity, not "money at risk". Severity ``high`` (the listing literally
cannot convert), never ``critical``.
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal

import asyncpg

from calderyn_engine.detectors import register
from calderyn_engine.schemas import DetectionResult

DETECTOR_ID = "out_of_stock_live"

_QUERY = """
WITH latest AS (
    -- Latest snapshot per (sku, location). Tiebreak on source_version so two
    -- observations that share observed_at (same-second backfill/sync) resolve
    -- deterministically — matches the repo's inventory views.
    SELECT DISTINCT ON (sku_id, location_id) sku_id, available
    FROM public.inventory_level_fact
    WHERE shop_id = $1
    ORDER BY sku_id, location_id, observed_at DESC, source_version DESC
),
totals AS (
    SELECT sku_id, sum(available)::numeric AS qty
    FROM latest
    GROUP BY sku_id
    HAVING sum(available) <= 0
)
SELECT t.sku_id, t.qty, d.sku AS sku_code, d.title AS sku_title
FROM totals t
JOIN public.sku_dim d ON d.id = t.sku_id
WHERE d.inventory_tracked IS TRUE
  AND d.product_status = 'active'
"""


def out_of_stock_result(sku_id, sku, title, available) -> DetectionResult:
    """Build the DetectionResult for one out-of-stock live SKU (pure)."""
    return DetectionResult(
        detector_id=DETECTOR_ID,
        entity_ref={"sku_id": str(sku_id), "sku": sku},
        severity="high",
        dollar_impact=Decimal("0"),
        evidence={"available": str(int(available)), "sku_title": title},
    )


@register(DETECTOR_ID)
async def detect(
    shop_id: str, conn: asyncpg.Connection, now: datetime
) -> list[DetectionResult]:
    rows = await conn.fetch(_QUERY, shop_id)
    return [
        out_of_stock_result(r["sku_id"], r["sku_code"], r["sku_title"], r["qty"])
        for r in rows
    ]
