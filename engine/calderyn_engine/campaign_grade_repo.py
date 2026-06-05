"""Compute + persist one campaign_grade_fact row per active campaign.

SQL returns pre-aggregated cents over the trailing window; the Decimal grade
math lives in calderyn_engine.grade. Mirrors the attribution/COGS join in
detectors/campaign_below_breakeven.py.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import asyncpg

from calderyn_engine.grade import (
    break_even_roas,
    derive_margin,
    grade_campaign,
)

_AGG_SQL = """
WITH win AS (
    SELECT $1::date AS day_end, ($1::date - ($2::int - 1)) AS day_start
),
spend_w AS (
    SELECT s.campaign_id, sum(s.spend_cents)::bigint AS spend_cents
    FROM public.ad_spend_fact s, win
    WHERE s.shop_id = $3::uuid
      AND s.day BETWEEN win.day_start AND win.day_end
    GROUP BY s.campaign_id
),
attr AS (
    SELECT a.campaign_id,
           sum(a.attributed_revenue_cents)::bigint AS revenue_cents
    FROM public.attribution_fact a
    JOIN public.order_fact o ON o.id = a.order_id AND o.shop_id = a.shop_id, win
    WHERE a.shop_id = $3::uuid
      AND a.campaign_id IS NOT NULL
      AND o.created_at_source::date BETWEEN win.day_start AND win.day_end
    GROUP BY a.campaign_id
),
lines AS (
    SELECT a.campaign_id,
           sum(ol.price_cents * ol.quantity)::bigint AS line_rev_total,
           sum(ol.price_cents * ol.quantity)
             FILTER (WHERE ol.unit_cost_cents_snapshot IS NOT NULL)::bigint
             AS line_rev_known,
           sum(ol.unit_cost_cents_snapshot * ol.quantity)
             FILTER (WHERE ol.unit_cost_cents_snapshot IS NOT NULL)::bigint
             AS line_cogs_known
    FROM public.attribution_fact a
    JOIN public.order_fact o ON o.id = a.order_id AND o.shop_id = a.shop_id
    JOIN public.order_line_fact ol ON ol.order_id = a.order_id AND ol.shop_id = a.shop_id, win
    WHERE a.shop_id = $3::uuid
      AND a.campaign_id IS NOT NULL
      AND o.created_at_source::date BETWEEN win.day_start AND win.day_end
    GROUP BY a.campaign_id
)
SELECT c.id AS campaign_id,
       coalesce(sp.spend_cents, 0)      AS spend_cents,
       coalesce(at.revenue_cents, 0)    AS revenue_cents,
       coalesce(ln.line_rev_total, 0)   AS line_rev_total,
       coalesce(ln.line_rev_known, 0)   AS line_rev_known,
       coalesce(ln.line_cogs_known, 0)  AS line_cogs_known
FROM public.ad_campaign_dim c
JOIN spend_w sp ON sp.campaign_id = c.id
LEFT JOIN attr  at ON at.campaign_id = c.id
LEFT JOIN lines ln ON ln.campaign_id = c.id
WHERE c.shop_id = $3::uuid
  AND c.status = 'active'
  AND sp.spend_cents > 0
"""

_UPSERT_SQL = """
INSERT INTO public.campaign_grade_fact (
    shop_id, campaign_id, day_bucket, window_days, grade,
    roas, break_even_roas, margin, confidence,
    spend_cents, revenue_cents, cogs_cents, computed_at
) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
ON CONFLICT (campaign_id, day_bucket) DO UPDATE SET
    window_days     = EXCLUDED.window_days,
    grade           = EXCLUDED.grade,
    roas            = EXCLUDED.roas,
    break_even_roas = EXCLUDED.break_even_roas,
    margin          = EXCLUDED.margin,
    confidence      = EXCLUDED.confidence,
    spend_cents     = EXCLUDED.spend_cents,
    revenue_cents   = EXCLUDED.revenue_cents,
    cogs_cents      = EXCLUDED.cogs_cents,
    computed_at     = now()
RETURNING campaign_id
"""

CENTS = Decimal("100")


async def grade_campaigns_for_shop(
    conn: asyncpg.Connection,
    shop_id: str,
    day: date,
    window_days: int = 7,
) -> list[str]:
    """Grade every active campaign with spend in the window; return graded ids.

    Caller must already hold ``with_shop_context(conn, shop_id)``.
    """
    rows = await conn.fetch(_AGG_SQL, day, window_days, shop_id)
    graded: list[str] = []
    for r in rows:
        spend = Decimal(r["spend_cents"]) / CENTS
        revenue = Decimal(r["revenue_cents"]) / CENTS
        line_rev_total = Decimal(r["line_rev_total"])
        line_rev_known = Decimal(r["line_rev_known"])
        line_cogs_known = Decimal(r["line_cogs_known"])

        coverage = (
            line_rev_known / line_rev_total if line_rev_total > 0 else Decimal("0")
        )
        margin, confidence = derive_margin(line_rev_known, line_cogs_known, coverage)
        be_roas = break_even_roas(margin)
        roas = revenue / spend if spend > 0 else Decimal("0")
        grade = grade_campaign(roas, be_roas)

        await conn.execute(
            _UPSERT_SQL,
            shop_id,
            str(r["campaign_id"]),
            day,
            window_days,
            grade,
            roas,
            be_roas,
            margin,
            confidence,
            int(r["spend_cents"]),
            int(r["revenue_cents"]),
            int(r["line_cogs_known"]),
        )
        graded.append(str(r["campaign_id"]))
    return graded
