"""Detector: negative_unit_economics.

Plan 03 Task 16b. Fires when a SKU's gross unit margin minus the per-unit
customer acquisition cost (CAC) attributable to it goes negative over the
trailing 14 days. Uses ``ad_creative_sku_map`` (only merchant-confirmed
mappings) to attribute campaign spend to SKUs and ``order_line_fact`` to
infer units sold from those campaigns.

Key Plan 02 schema notes:
- ``ad_creative_sku_map.source`` is text — we filter to
  ``source IN ('merchant_confirmed', 'merchant_manual')`` instead of the
  hypothetical ``confirmed_by_merchant`` boolean.
- All money fields are *_cents integers.
- Attribution and spend live in distinct tables with no campaign-level join
  on units; we approximate units from ``order_line_fact`` joined through
  ``attribution_fact``.
"""
from __future__ import annotations

from datetime import datetime
from decimal import Decimal

import asyncpg

from calderyn_engine.detectors import register
from calderyn_engine.schemas import DetectionResult

DETECTOR_ID = "negative_unit_economics"
DEFAULT_THRESHOLD_USD = Decimal("500")

_QUERY = """
WITH lines_14d AS (
  SELECT ol.sku_id,
         o.id AS order_id,
         ol.quantity,
         ol.price_cents,
         coalesce(ol.unit_cost_cents_snapshot, 0) AS unit_cost_cents
  FROM public.order_line_fact ol
  JOIN public.order_fact o ON o.id = ol.order_id AND o.shop_id = ol.shop_id
  WHERE ol.shop_id = $1
    AND o.created_at_source >= (now() - interval '14 days')
    AND ol.sku_id IS NOT NULL
),
margin_per_sku AS (
  SELECT sku_id,
         sum(quantity)                                                 AS units,
         (sum(price_cents * quantity) - sum(unit_cost_cents * quantity))::numeric
           / NULLIF(sum(quantity), 0)                                  AS unit_margin_cents
  FROM lines_14d
  GROUP BY sku_id
),
attributed_spend AS (
  SELECT m.sku_id,
         sum(s.spend_cents)::numeric AS spend_cents
  FROM public.ad_creative_sku_map m
  JOIN public.ad_campaign_dim c
    ON c.shop_id = m.shop_id
   AND c.platform = m.platform
  JOIN public.ad_spend_fact s
    ON s.campaign_id = c.id
   AND s.shop_id = c.shop_id
  WHERE m.shop_id = $1
    AND m.source IN ('merchant_confirmed', 'merchant_manual')
    AND m.sku_id IS NOT NULL
    AND s.day >= (current_date - interval '14 days')
  GROUP BY m.sku_id
),
attributed_units AS (
  SELECT ol.sku_id,
         sum(ol.quantity)::numeric AS units
  FROM public.order_line_fact ol
  JOIN public.attribution_fact a ON a.order_id = ol.order_id AND a.shop_id = ol.shop_id
  JOIN public.order_fact o ON o.id = ol.order_id AND o.shop_id = ol.shop_id
  WHERE ol.shop_id = $1
    AND a.campaign_id IS NOT NULL
    AND o.created_at_source >= (now() - interval '14 days')
    AND ol.sku_id IS NOT NULL
  GROUP BY ol.sku_id
)
SELECT m.sku_id,
       m.units                                       AS units_14d,
       m.unit_margin_cents                           AS unit_margin_cents,
       coalesce(s.spend_cents, 0)                    AS attributed_spend_cents,
       coalesce(u.units, 0)                          AS attributed_units,
       d.sku                                         AS sku_code,
       d.title                                       AS title
FROM margin_per_sku m
LEFT JOIN attributed_spend s ON s.sku_id = m.sku_id
LEFT JOIN attributed_units u ON u.sku_id = m.sku_id
JOIN public.sku_dim d ON d.id = m.sku_id
WHERE coalesce(s.spend_cents, 0) > 0
  AND coalesce(u.units, 0) > 0
"""


@register(DETECTOR_ID)
async def detect(
    shop_id: str, conn: asyncpg.Connection, now: datetime
) -> list[DetectionResult]:
    rows = await conn.fetch(_QUERY, shop_id)
    out: list[DetectionResult] = []
    for r in rows:
        unit_margin_cents = Decimal(r["unit_margin_cents"] or 0)
        spend_cents = Decimal(r["attributed_spend_cents"] or 0)
        attrib_units = Decimal(r["attributed_units"] or 0)
        units_14d = Decimal(r["units_14d"] or 0)
        if attrib_units <= 0 or units_14d <= 0:
            continue
        cac_per_unit_cents = spend_cents / attrib_units
        net_per_unit_cents = unit_margin_cents - cac_per_unit_cents
        if net_per_unit_cents >= 0:
            continue
        net_per_unit_dollars = net_per_unit_cents / Decimal(100)
        impact = (abs(net_per_unit_dollars) * units_14d).quantize(
            Decimal("0.01")
        )
        if impact < DEFAULT_THRESHOLD_USD:
            continue
        out.append(
            DetectionResult(
                detector_id=DETECTOR_ID,
                entity_ref={"sku_id": str(r["sku_id"]), "sku": r["sku_code"]},
                severity="high",
                dollar_impact=impact,
                evidence={
                    "gross_unit_margin_usd": str(
                        (unit_margin_cents / Decimal(100)).quantize(
                            Decimal("0.01")
                        )
                    ),
                    "cac_per_unit_usd": str(
                        (cac_per_unit_cents / Decimal(100)).quantize(
                            Decimal("0.01")
                        )
                    ),
                    "net_per_unit_usd": str(
                        net_per_unit_dollars.quantize(Decimal("0.01"))
                    ),
                    "units_14d": int(units_14d),
                    "title": r["title"],
                },
            )
        )
    return out
