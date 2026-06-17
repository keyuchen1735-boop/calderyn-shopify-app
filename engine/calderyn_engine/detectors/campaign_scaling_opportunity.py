"""Detector: winning ad campaigns with meaningful incremental margin upside.

F1 campaigns-scale-up Task 4. For every active campaign whose latest
campaign_grade_fact row is 'winning', we project the incremental contribution
margin from raising the daily budget by ``autopilot_max_budget_increase_pct``
(default 20 %) over a 30-day horizon. Campaigns whose upside is below
``DEFAULT_THRESHOLD_USD`` are dropped — they're winners but too small to act
on in a ranked alert list.

All money fields stored as ``*_cents integer``; converted to ``Decimal`` USD
at the SQL→Python boundary. The guardrail pct is shop-scoped via
guardrail_config (auto-seeded by trigger on shop insert).
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal

import asyncpg

from calderyn_engine.detectors import register
from calderyn_engine.estimators.scale_upside import estimate_scale_upside
from calderyn_engine.schemas import DetectionResult

DETECTOR_ID = "campaign_scaling_opportunity"
DEFAULT_THRESHOLD_USD = Decimal("25")

# Latest grade per campaign (DISTINCT ON) joined to the campaign dim for
# budget and platform. Reads guardrail_config for the per-shop increase cap
# (falls back to 20 % if the row is missing — not expected in prod, but
# defensive). Filters: grade='winning', status='active', budget known and > 0.
_QUERY = """
WITH latest_grade AS (
    SELECT DISTINCT ON (campaign_id)
           campaign_id,
           grade,
           roas,
           margin
    FROM   public.campaign_grade_fact
    WHERE  shop_id = $1
    ORDER  BY campaign_id, day_bucket DESC
),
guardrail AS (
    SELECT coalesce(autopilot_max_budget_increase_pct, 20) AS increase_pct
    FROM   public.guardrail_config
    WHERE  shop_id = $1
)
SELECT c.id            AS campaign_id,
       c.name          AS campaign_name,
       c.platform      AS platform,
       c.daily_budget_cents                AS daily_budget_cents,
       g.grade         AS grade,
       g.roas          AS roas,
       g.margin        AS margin,
       coalesce((SELECT increase_pct FROM guardrail), 20) AS increase_pct
FROM   public.ad_campaign_dim c
JOIN   latest_grade g ON g.campaign_id = c.id
WHERE  c.shop_id = $1
  AND  c.status  = 'active'
  AND  g.grade   = 'winning'
  AND  c.daily_budget_cents IS NOT NULL
  AND  c.daily_budget_cents > 0
"""


@register(DETECTOR_ID)
async def detect(
    shop_id: str, conn: asyncpg.Connection, now: datetime
) -> list[DetectionResult]:
    """Run the detector and return zero-or-more DetectionResult rows."""

    rows = await conn.fetch(_QUERY, shop_id)
    out: list[DetectionResult] = []
    for r in rows:
        roas = Decimal(str(r["roas"]))
        margin = Decimal(str(r["margin"]))
        daily_budget_cents = int(r["daily_budget_cents"])
        increase_pct = int(r["increase_pct"])

        impact = estimate_scale_upside(
            current_daily_cents=daily_budget_cents,
            roas=roas,
            margin=margin,
            increase_pct=increase_pct,
            horizon_days=30,
        )
        if impact < DEFAULT_THRESHOLD_USD:
            continue

        out.append(
            DetectionResult(
                detector_id=DETECTOR_ID,
                entity_ref={
                    "campaign_id": str(r["campaign_id"]),
                    "platform": r["platform"],
                },
                severity="medium",
                dollar_impact=impact,
                evidence={
                    "campaign_name": r["campaign_name"],
                    "grade": r["grade"],
                    "roas": str(roas),
                    "margin": str(margin),
                    "daily_budget_usd": str(Decimal(daily_budget_cents) / Decimal("100")),
                    "increase_pct": increase_pct,
                },
            )
        )
    return out
