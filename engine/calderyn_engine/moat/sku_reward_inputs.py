"""Derive reward inputs for SKU/variant/location-scoped autopilot actions
(discontinue_sku, adjust_price, reallocate_inventory). Mirrors
action_reward_inputs.py but reads SKU economics instead of campaign ROAS.
Own raw data only (invariant A5). pgbouncer-safe plain fetches.

Spike-confirmed (see test_sku_action_rewards.py header for files):
- All three kinds carry params->>'sku_id'; only reallocate_inventory carries
  params->>'delta'. params->>'to_location_id' is the Shopify external location
  GID, not location_dim.id, so v1 reads SKU-wide economics over the post window
  rather than destination-location-specific sales.
- order_line_fact ⨝ order_fact mirrors detectors/negative_unit_economics.py;
  the window-date column on order_fact is created_at_source.

The actions query is aliased `action_audit AS s` so its SELECT prefix
("SELECT s.id") is distinct from the campaign path's "SELECT a.id" — that keeps
the two derivations independently dispatchable in fake-conn tests and prevents
the campaign-scoped persist test from re-routing campaign rows through here.
"""
from __future__ import annotations
from datetime import date, datetime, timedelta

from calderyn_engine.moat.action_reward_inputs import ActionRewardInput, WINDOW_DAYS
from calderyn_engine.moat.action_reward_windows import confirmation_window_days
from calderyn_engine.moat.sku_action_rewards import (
    compute_sku_action_reward,
    compute_inventory_reward,
)

# SKU autopilot actions: sku_id from params, detector from the joined alert.
_SKU_ACTIONS_SQL = """
SELECT s.id, s.action_kind, s.created_at,
       (s.params->>'sku_id')         AS sku_id,
       (s.params->>'to_location_id') AS to_location_id,
       (s.params->>'delta')::int     AS delta,
       COALESCE(al.detector_id, 'unknown') AS detector_id,
       EXISTS (SELECT 1 FROM public.action_audit u WHERE u.undo_of = s.id) AS undone
  FROM public.action_audit s
  LEFT JOIN public.alerts al ON al.id = s.alert_id
 WHERE s.shop_id = $1 AND s.actor_user_id = 'autopilot' AND s.outcome = 'succeeded'
   AND s.action_kind IN ('discontinue_sku','adjust_price','reallocate_inventory')
"""

# Per-SKU unit economics + units over a window (mirrors negative_unit_economics).
_SKU_ECON_SQL = """
SELECT ol.sku_id,
       SUM(ol.quantity)                                                   AS units,
       (SUM(ol.price_cents * ol.quantity)
        - SUM(COALESCE(ol.unit_cost_cents_snapshot,0) * ol.quantity))::numeric
        / NULLIF(SUM(ol.quantity),0)                                      AS unit_margin_cents
  FROM public.order_line_fact ol
  JOIN public.order_fact o ON o.id = ol.order_id AND o.shop_id = ol.shop_id
 WHERE ol.shop_id = $1 AND ol.sku_id = $2
   AND o.created_at_source >= $3 AND o.created_at_source < $4
 GROUP BY ol.sku_id
"""


async def derive_sku_action_reward_inputs(
    conn, shop_id: str, run_date: date
) -> list[ActionRewardInput]:
    """Yield one ActionRewardInput per succeeded SKU-scoped autopilot action.

    Same shape as derive_action_reward_inputs, with campaign_id left "" (these
    kinds have no campaign) and window_closed gated on the per-kind confirmation
    window (action_reward_windows.confirmation_window_days).
    """
    rows = await conn.fetch(_SKU_ACTIONS_SQL, shop_id)
    out: list[ActionRewardInput] = []
    for a in rows:
        created = a["created_at"]
        if not isinstance(created, datetime):
            created = datetime.fromisoformat(str(created))
        ad = created.date()
        win = confirmation_window_days(a["action_kind"])
        lo = ad - timedelta(days=WINDOW_DAYS)   # PRE stays a 14d baseline
        hi = ad + timedelta(days=win)            # POST is per-kind
        window_closed = run_date >= hi

        if a["action_kind"] == "reallocate_inventory":
            post = await conn.fetch(_SKU_ECON_SQL, shop_id, a["sku_id"], ad, hi)
            units = int(post[0]["units"]) if post else 0
            margin = int(post[0]["unit_margin_cents"]) if post else 0
            # v1: source_stockout_units=0 — a refinement once stockout
            # attribution at the source location is wired (inventory_level_fact
            # carries observed_at/available for it). Documented, not silently
            # dropped.
            reward = compute_inventory_reward(units, margin, 0, bool(a["undone"]))
        else:
            pre = await conn.fetch(_SKU_ECON_SQL, shop_id, a["sku_id"], lo, ad)
            post = await conn.fetch(_SKU_ECON_SQL, shop_id, a["sku_id"], ad, hi)
            pre_econ = int(pre[0]["unit_margin_cents"]) if pre else 0
            post_econ = int(post[0]["unit_margin_cents"]) if post else 0
            units = int(post[0]["units"]) if post else (int(pre[0]["units"]) if pre else 0)
            reward = compute_sku_action_reward(
                a["action_kind"], pre_econ, post_econ, units, bool(a["undone"]),
            )

        out.append(
            ActionRewardInput(
                shop_id=shop_id,
                detector_id=a["detector_id"],
                action_kind=a["action_kind"],
                campaign_id="",
                chosen_pct=0.0,
                reward=reward,
                action_id=a["id"],
                window_closed=window_closed,
                action_created_at=created,
            )
        )
    return out
