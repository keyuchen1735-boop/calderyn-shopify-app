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
# A SKU must carry at least this much attributed spend to be named as the
# offender; otherwise the alert stays shop-level rather than blaming a SKU with
# trivial spend. $500 — half the shop-level floor.
MIN_OFFENDER_SPEND_CENTS = 50_000


def select_ad_tax_offender(rows, min_spend_cents=MIN_OFFENDER_SPEND_CENTS):
    """Pick the SKU contributing the most attributed ad spend — the worst
    ad-tax offender to name on the (shop-level) alert so remediation has a
    concrete target. Returns the row, or None when no SKU clears the spend
    floor (the alert then stays shop-level)."""
    best = None
    for r in rows:
        spend = r.get("attributed_spend_cents") or 0
        if spend < min_spend_cents:
            continue
        if best is None or spend > (best.get("attributed_spend_cents") or 0):
            best = r
    return best

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

# Per-SKU attributed ad spend over the same 7-day window — the shop-level ratio
# fires, but the alert names the worst-offender SKU so remediation (move budget /
# cut ads) has a concrete target. Mirrors negative_unit_economics' attribution:
# merchant-confirmed ad_creative_sku_map -> ad_campaign_dim -> ad_spend_fact.
_OFFENDER_QUERY = """
WITH attributed_spend AS (
  SELECT m.sku_id,
         sum(s.spend_cents)::bigint AS spend_cents
  FROM public.ad_creative_sku_map m
  JOIN public.ad_campaign_dim c
    ON c.shop_id = m.shop_id AND c.platform = m.platform
  JOIN public.ad_spend_fact s
    ON s.campaign_id = c.id AND s.shop_id = c.shop_id
  WHERE m.shop_id = $1
    AND m.source IN ('merchant_confirmed', 'merchant_manual')
    AND m.sku_id IS NOT NULL
    AND s.day >= (current_date - interval '7 days')
  GROUP BY m.sku_id
)
SELECT a.sku_id,
       a.spend_cents AS attributed_spend_cents,
       d.sku         AS sku,
       d.title       AS title
FROM attributed_spend a
JOIN public.sku_dim d ON d.id = a.sku_id
ORDER BY a.spend_cents DESC, a.sku_id
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

    evidence = {
        "ad_spend_7d_usd": str(
            (spend_cents / Decimal(100)).quantize(Decimal("0.01"))
        ),
        "revenue_7d_usd": str(
            (revenue_cents / Decimal(100)).quantize(Decimal("0.01"))
        ),
        "ad_tax_ratio": str(ratio.quantize(Decimal("0.001"))),
        "threshold": str(AD_TAX_THRESHOLD),
    }

    # The trigger is shop-level, but blame the worst-offender SKU so the dashboard
    # remediation (move budget / cut ads) has a concrete target. No attributable
    # SKU -> stay shop-level (unchanged behavior; never a dead remediation target).
    offender_rows = await conn.fetch(_OFFENDER_QUERY, shop_id)
    offender = select_ad_tax_offender([dict(r) for r in offender_rows])
    if offender is not None:
        entity_ref = {"sku_id": str(offender["sku_id"]), "sku": offender["sku"]}
        evidence["sku_id"] = str(offender["sku_id"])
        evidence["sku_title"] = offender["title"]
    else:
        entity_ref = {"scope": "shop", "shop_id": str(shop_id)}

    return [
        DetectionResult(
            detector_id=DETECTOR_ID,
            entity_ref=entity_ref,
            severity="high" if ratio >= Decimal("0.60") else "medium",
            dollar_impact=impact,
            evidence=evidence,
        )
    ]
