"""Detector: a campaign Calderyn auto-paused for a stockout is now restocked.

Slice B of the autopilot trust UX (auto-resume on stockout-clear). Emits one
alert per (campaign, sku) where ALL of the following hold:

1. Calderyn auto-paused the campaign for ``sku_stockout_vs_spend``: there is a
   succeeded ``pause_campaign`` row in ``action_audit`` with
   ``actor_user_id = 'autopilot'`` whose originating alert was a
   ``sku_stockout_vs_spend`` alert. ``params->>'campaign_id'`` is the campaign,
   the alert's ``entity_ref->>'sku_id'`` is the SKU. (product fork #1)
2. That stockout pause is still the LATEST action on the campaign — the merchant
   never took it over afterwards — and the campaign is still paused on the
   platform. (product fork #1: never un-pause something the merchant owns now.)
3. The SKU is restocked ABOVE a buffer that covers the ads: total on-hand
   (latest per location) ``>= restock_buffer_units(velocity)`` so the campaign
   will not resume and immediately sell out again. (product fork #2)

The alert maps to ``resume_campaign`` via ``DETECTOR_TO_ACTIONS`` (TS side). Like
every other autonomous action it only fires once the merchant has graduated and
enabled the pair (Slice C warm-up gate); until then it surfaces as a suggestion.

``entity_ref`` carries ``campaign_id`` so ``v_autopilot_candidates`` resolves the
campaign for the autopilot resume branch.
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal, ROUND_CEILING
from typing import Any

import asyncpg

from calderyn_engine.detectors import register
from calderyn_engine.schemas import DetectionResult

DETECTOR_ID = "sku_stockout_cleared"

# Restock buffer (product fork #2): resume only once on-hand stock covers at
# least BUFFER_DAYS of selling velocity, with an absolute floor so slow movers
# still need a sensible minimum. This prevents a resume → immediate re-pause
# flip-flop when only a trickle of stock came back.
BUFFER_DAYS = Decimal("3")
MIN_RESTOCK_UNITS = 5


def restock_buffer_units(
    velocity: Decimal, fallback_velocity: Decimal = Decimal("0")
) -> int:
    """Units of stock required before a paused campaign may resume.

    ``= max(MIN_RESTOCK_UNITS, ceil(velocity * BUFFER_DAYS))``. ``velocity`` is
    the current daily selling rate; while ads are paused it can read 0, so we
    fall back to ``fallback_velocity`` (the pause-time velocity) which reflects
    demand once ads resume.
    """
    v = velocity if velocity and velocity > 0 else fallback_velocity
    if v is None or v <= 0:
        return MIN_RESTOCK_UNITS
    needed = int((v * BUFFER_DAYS).to_integral_value(rounding=ROUND_CEILING))
    return max(MIN_RESTOCK_UNITS, needed)


def stockout_cleared_result(
    *,
    campaign_id: str,
    sku_id: str,
    sku_code: str | None,
    sku_title: str | None,
    stock_units: Decimal,
    velocity: Decimal,
    unit_margin: Decimal,
    prepause_spend_usd: Decimal,
    fallback_velocity: Decimal = Decimal("0"),
) -> DetectionResult | None:
    """Build the resume-candidate alert, or None when not restocked enough.

    Returns None unless ``stock_units >= restock_buffer_units(...)`` (fork #2).
    ``dollar_impact`` is a modest recovered-profit estimate over the buffer
    horizon, falling back to the at-stake pre-pause spend when margin is unknown.
    """
    buffer = restock_buffer_units(velocity, fallback_velocity)
    if stock_units < buffer:
        return None

    v_eff = velocity if velocity and velocity > 0 else fallback_velocity
    recovered = (
        v_eff * BUFFER_DAYS * unit_margin
        if (v_eff and v_eff > 0 and unit_margin and unit_margin > 0)
        else Decimal("0")
    )
    impact = recovered if recovered > 0 else prepause_spend_usd
    if impact < 0:
        impact = Decimal("0")

    evidence: dict[str, Any] = {
        # campaign_id mirrors entity_ref so the merchant-approve path (the alert
        # action handler reads alert.evidence.campaign_id) can execute the resume.
        # EvidencePanel suppresses campaign_id, so it never renders to the merchant.
        "campaign_id": str(campaign_id),
        "stock_units": str(stock_units),
        "buffer_units": str(buffer),
        "velocity_units_per_day": str(v_eff),
        "prepause_spend_7d_usd": str(prepause_spend_usd),
        "sku_title": sku_title,
    }
    return DetectionResult(
        detector_id=DETECTOR_ID,
        entity_ref={
            "campaign_id": str(campaign_id),
            "sku_id": str(sku_id),
            "sku": sku_code,
        },
        severity="medium",
        dollar_impact=impact,
        evidence=evidence,
    )


def _unit_margin_dollars(margin_cents: Decimal, velocity: Decimal) -> Decimal:
    """Per-unit margin in dollars from a 7-day P&L slice (mirrors the stockout
    detector): 7-day contribution margin / (velocity_per_day * 7)."""
    if velocity <= 0:
        return Decimal("0")
    units_7d = velocity * Decimal("7")
    return (margin_cents / Decimal("100") / units_7d) if units_7d > 0 else Decimal("0")


# Candidate selection (fork #1) + the live facts each candidate needs. The buffer
# decision (fork #2) lives in the pure helper above so it is unit-tested without
# a DB. Inactive-status set mirrors INACTIVE_CAMPAIGN_STATUSES in
# app/lib/calibration/preconditions.server.ts.
_QUERY = """
WITH stockout_pause AS (
    -- The most recent succeeded autopilot pause from a stockout alert, per
    -- campaign, carrying the pause-time velocity from the alert evidence.
    SELECT DISTINCT ON ((aa.params->>'campaign_id'))
           (aa.params->>'campaign_id')::uuid                   AS campaign_id,
           (al.entity_ref->>'sku_id')::uuid                    AS sku_id,
           aa.created_at                                       AS paused_at,
           (ac.evidence->>'velocity_units_per_day')::numeric   AS pause_velocity
    FROM public.action_audit aa
    JOIN public.alerts al        ON al.id = aa.alert_id
    LEFT JOIN public.alert_context ac ON ac.alert_id = al.id
    WHERE aa.shop_id = $1
      AND aa.action_kind = 'pause_campaign'
      AND aa.outcome = 'succeeded'
      AND aa.actor_user_id = 'autopilot'
      AND al.detector_id = 'sku_stockout_vs_spend'
      AND (aa.params->>'campaign_id') IS NOT NULL
      AND (al.entity_ref->>'sku_id') IS NOT NULL
    ORDER BY (aa.params->>'campaign_id'), aa.created_at DESC
),
calderyn_paused AS (
    -- fork #1: keep only campaigns whose stockout pause is the latest SUCCEEDED
    -- action_audit row for the campaign (the merchant never acted on it
    -- afterwards). outcome='succeeded' so a transient failed/retrying autopilot
    -- resume attempt cannot permanently suppress re-emission of the alert.
    SELECT sp.*
    FROM stockout_pause sp
    WHERE NOT EXISTS (
        SELECT 1 FROM public.action_audit a2
        WHERE a2.shop_id = $1
          AND (a2.params->>'campaign_id')::uuid = sp.campaign_id
          AND a2.outcome = 'succeeded'
          AND a2.created_at > sp.paused_at
    )
),
still_paused AS (
    -- Campaign must still be paused on the platform (lowercase orchestrator
    -- snapshots: anything that is not active/enabled is paused/ended/etc.).
    SELECT cp.*
    FROM calderyn_paused cp
    JOIN public.ad_campaign_dim c
      ON c.id = cp.campaign_id AND c.shop_id = $1
    WHERE lower(c.status) NOT IN ('active', 'enabled')
),
current_stock AS (
    -- Latest-per-location on-hand, ignoring observations older than 24h so the
    -- alert never fires on a stale inventory feed (mirrors the stockout detector's
    -- 24h window). A location whose latest reading is stale contributes nothing.
    SELECT sku_id, sum(available)::numeric AS stock_units
    FROM (
        SELECT DISTINCT ON (sku_id, location_id) sku_id, location_id, available
        FROM public.inventory_level_fact
        WHERE shop_id = $1
          AND observed_at >= now() - interval '24 hours'
        ORDER BY sku_id, location_id, observed_at DESC
    ) latest
    GROUP BY sku_id
),
latest_velocity AS (
    SELECT DISTINCT ON (sku_id) sku_id, units
    FROM public.sku_velocity
    WHERE shop_id = $1 AND window_days = 1
    ORDER BY sku_id, computed_at DESC
),
recent_pnl AS (
    SELECT sku_id, sum(contribution_margin_cents)::numeric AS margin_cents
    FROM public.sku_pnl
    WHERE shop_id = $1 AND day >= (now() - interval '7 days')::date
    GROUP BY sku_id
),
prepause_spend AS (
    SELECT sp.campaign_id,
           coalesce(sum(s.spend_cents), 0)::numeric AS spend_cents
    FROM still_paused sp
    LEFT JOIN public.ad_spend_fact s
      ON s.campaign_id = sp.campaign_id
     AND s.shop_id = $1
     AND s.day >  (sp.paused_at - interval '7 days')::date
     AND s.day <= sp.paused_at::date
    GROUP BY sp.campaign_id
)
SELECT sp.campaign_id,
       sp.sku_id,
       sp.pause_velocity,
       coalesce(cs.stock_units, 0)::numeric AS stock_units,
       coalesce(v.units, 0)::numeric        AS velocity,
       coalesce(p.margin_cents, 0)::numeric AS margin_cents_7d,
       coalesce(ps.spend_cents, 0)::numeric AS prepause_spend_cents,
       d.sku   AS sku_code,
       d.title AS sku_title
FROM still_paused sp
LEFT JOIN current_stock   cs ON cs.sku_id = sp.sku_id
LEFT JOIN latest_velocity v  ON v.sku_id  = sp.sku_id
LEFT JOIN recent_pnl      p  ON p.sku_id  = sp.sku_id
LEFT JOIN prepause_spend  ps ON ps.campaign_id = sp.campaign_id
LEFT JOIN public.sku_dim  d  ON d.id = sp.sku_id
"""


@register(DETECTOR_ID)
async def detect(
    shop_id: str, conn: asyncpg.Connection, now: datetime
) -> list[DetectionResult]:
    """Run the detector and return zero-or-more resume-candidate alerts."""
    rows = await conn.fetch(_QUERY, shop_id)
    out: list[DetectionResult] = []
    for r in rows:
        velocity = Decimal(r["velocity"])
        pause_velocity = (
            Decimal(r["pause_velocity"]) if r["pause_velocity"] is not None else Decimal("0")
        )
        unit_margin = _unit_margin_dollars(
            Decimal(r["margin_cents_7d"]),
            velocity if velocity > 0 else pause_velocity,
        )
        result = stockout_cleared_result(
            campaign_id=str(r["campaign_id"]),
            sku_id=str(r["sku_id"]),
            sku_code=r["sku_code"],
            sku_title=r["sku_title"],
            stock_units=Decimal(r["stock_units"]),
            velocity=velocity,
            fallback_velocity=pause_velocity,
            unit_margin=unit_margin,
            prepause_spend_usd=Decimal(r["prepause_spend_cents"]) / Decimal("100"),
        )
        if result is not None:
            out.append(result)
    return out
