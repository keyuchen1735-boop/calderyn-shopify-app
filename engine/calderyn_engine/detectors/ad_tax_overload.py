"""Detector: ad_tax_overload.

Plan 03 Task 16a. Fires when a shop's combined ad spend across all platforms
exceeds 40% of attributed revenue over the trailing 7 days. Uses
``ad_spend_fact.spend_cents`` and ``attribution_fact.attributed_revenue_cents``
(Plan 02 schema — both stored in cents).

Spend is keyed by ``(campaign_id, day)`` while attribution is keyed by
``(order_id, campaign_id)``; the totals are computed independently and
combined at the shop level rather than via a join.
"""
from __future__ import annotations

from datetime import datetime
from decimal import Decimal

import asyncpg

from calderyn_engine.detectors import register
from calderyn_engine.schemas import DetectionResult

DETECTOR_ID = "ad_tax_overload"
AD_TAX_THRESHOLD = Decimal("0.40")
MIN_SPEND_CENTS = 100_000  # $1,000 lower bound; below this the ratio is noisy

_QUERY = """
WITH spend AS (
  SELECT coalesce(sum(s.spend_cents), 0) AS spend_cents
  FROM public.ad_spend_fact s
  WHERE s.shop_id = $1
    AND s.day >= (current_date - interval '7 days')
),
revenue AS (
  SELECT coalesce(sum(a.attributed_revenue_cents), 0) AS revenue_cents
  FROM public.attribution_fact a
  JOIN public.order_fact o ON o.id = a.order_id AND o.shop_id = a.shop_id
  WHERE a.shop_id = $1
    AND o.created_at_source >= (now() - interval '7 days')
)
SELECT spend.spend_cents, revenue.revenue_cents FROM spend, revenue
"""


@register(DETECTOR_ID)
async def detect(
    shop_id: str, conn: asyncpg.Connection, now: datetime
) -> list[DetectionResult]:
    row = await conn.fetchrow(_QUERY, shop_id)
    if row is None:
        return []
    spend_cents = Decimal(row["spend_cents"] or 0)
    revenue_cents = Decimal(row["revenue_cents"] or 0)
    if spend_cents < MIN_SPEND_CENTS:
        return []
    if revenue_cents <= 0:
        return []
    ratio = spend_cents / revenue_cents
    if ratio < AD_TAX_THRESHOLD:
        return []
    excess_cents = spend_cents - revenue_cents * AD_TAX_THRESHOLD
    impact = (excess_cents / Decimal(100)).quantize(Decimal("0.01"))
    if impact <= 0:
        return []
    return [
        DetectionResult(
            detector_id=DETECTOR_ID,
            entity_ref={"scope": "shop", "shop_id": str(shop_id)},
            severity="high" if ratio >= Decimal("0.60") else "medium",
            dollar_impact=impact,
            evidence={
                "ad_spend_7d_usd": str(
                    (spend_cents / Decimal(100)).quantize(Decimal("0.01"))
                ),
                "revenue_7d_usd": str(
                    (revenue_cents / Decimal(100)).quantize(Decimal("0.01"))
                ),
                "ad_tax_ratio": str(ratio.quantize(Decimal("0.001"))),
                "threshold": str(AD_TAX_THRESHOLD),
            },
        )
    ]
