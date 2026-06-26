"""D1 — derive per-action reward inputs for a shop (spec 2026-06-19 §4).

One query reads the shop's autopilot action_audit rows (with old/new budget and
undo flag); a second reads ad_spend_fact bucketed into pre/post 14d windows; a
third reads break-even per campaign. compute_action_reward turns each into a
scalar. Own raw data only (invariant A5). pgbouncer-safe: plain fetches.
"""
from __future__ import annotations
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Any, TypedDict

from calderyn_engine.moat.action_reward_windows import confirmation_window_days
from calderyn_engine.moat.action_rewards import compute_action_reward

WINDOW_DAYS = 14


class ActionRewardInput(TypedDict):
    shop_id: str
    detector_id: str
    action_kind: str
    campaign_id: str
    chosen_pct: float
    reward: Decimal
    action_id: str
    window_closed: bool
    action_created_at: datetime


_ACTIONS_SQL = """
SELECT a.id, a.action_kind,
       (a.params->>'campaign_id') AS campaign_id,
       a.created_at,
       COALESCE(al.detector_id, 'unknown') AS detector_id,
       (a.pre_state->>'daily_budget_cents')::int AS old_budget_cents,
       (a.params->>'daily_budget_cents')::int    AS new_budget_cents,
       EXISTS (SELECT 1 FROM public.action_audit u WHERE u.undo_of = a.id) AS undone
  FROM public.action_audit a
  LEFT JOIN public.alerts al ON al.id = a.alert_id
 WHERE a.shop_id = $1 AND a.actor_user_id = 'autopilot' AND a.outcome = 'succeeded'
"""

_SPEND_SQL = """
SELECT campaign_id,
       CASE WHEN day <  $2 THEN 'pre' ELSE 'post' END AS phase,
       SUM(spend_cents)          AS spend_cents,
       SUM(revenue_attrib_cents) AS revenue_cents
  FROM public.ad_spend_fact
 WHERE shop_id = $1 AND day >= $3 AND day < $4
 GROUP BY campaign_id, phase
"""

_GRADE_SQL = (
    "SELECT DISTINCT ON (campaign_id) campaign_id, break_even_roas "
    "FROM public.campaign_grade_fact WHERE shop_id = $1 "
    "ORDER BY campaign_id, day_bucket DESC"
)


def _roas(spend: int, rev: int) -> Decimal:
    return (Decimal(rev) / Decimal(spend)) if spend else Decimal("0")


async def derive_action_reward_inputs(
    conn: Any, shop_id: str, run_date: date
) -> list[ActionRewardInput]:
    """Yield one ActionRewardInput per succeeded autopilot action for ``shop_id``.

    Parameters
    ----------
    conn:
        asyncpg connection (or compatible). The caller owns transaction scope.
    shop_id:
        Tenant identifier. Scopes all reads to this shop's own data (invariant A5).
    run_date:
        The logical date of the run; currently unused in queries (window anchors
        on action.created_at) but kept for caller context and future incremental
        filtering.

    Returns
    -------
    list[ActionRewardInput]
        One dict per action. Keys exactly: shop_id, detector_id, action_kind,
        campaign_id, chosen_pct, reward, action_id — the seam consumed by the
        peer ETL (Task 7) and trainer (Task 8).
    """
    actions = await conn.fetch(_ACTIONS_SQL, shop_id)

    grade_rows = await conn.fetch(_GRADE_SQL, shop_id)
    grades: dict[str, Decimal] = {
        g["campaign_id"]: Decimal(str(g["break_even_roas"])) for g in grade_rows
    }
    # v1 simplification: a campaign with no grade row defaults to break_even=1.0
    # (see the `grades.get(cid, Decimal("1"))` below). The spec names
    # v_campaigns_flat as an alternate break-even source; wiring it as a fallback
    # is a deferred refinement. This only affects a SHOP'S OWN dormant reward
    # signal (no live behavior, no cross-tenant aggregate), so 1.0 is a safe,
    # conservative default until the trainer has real action history to learn from.

    out: list[ActionRewardInput] = []
    for a in actions:
        created = a["created_at"]
        if not isinstance(created, datetime):
            created = datetime.fromisoformat(str(created))

        action_date = created.date()
        win_days = confirmation_window_days(a["action_kind"])
        lo = action_date - timedelta(days=WINDOW_DAYS)   # PRE stays a 14d baseline
        hi = action_date + timedelta(days=win_days)       # POST is per-kind
        window_closed = run_date >= hi

        spend_rows = await conn.fetch(_SPEND_SQL, shop_id, action_date, lo, hi)
        agg = {(r["campaign_id"], r["phase"]): r for r in spend_rows}

        cid = a["campaign_id"]
        pre = agg.get((cid, "pre"), {"spend_cents": 0, "revenue_cents": 0})
        post = agg.get((cid, "post"), {"spend_cents": 0, "revenue_cents": 0})

        pre_spend = int(pre["spend_cents"])
        pre_rev = int(pre["revenue_cents"])
        post_spend = int(post["spend_cents"])
        post_rev = int(post["revenue_cents"])

        reward = compute_action_reward(
            a["action_kind"],
            _roas(pre_spend, pre_rev),
            _roas(post_spend, post_rev),
            pre_rev - pre_spend,
            post_rev - post_spend,
            grades.get(cid, Decimal("1")),
            bool(a["undone"]),
        )

        old = a["old_budget_cents"] or 0
        new = a["new_budget_cents"] or 0
        chosen_pct = abs(new - old) / old * 100.0 if old else 0.0

        out.append(
            ActionRewardInput(
                shop_id=shop_id,
                detector_id=a["detector_id"],
                action_kind=a["action_kind"],
                campaign_id=cid,
                chosen_pct=float(chosen_pct),
                reward=reward,
                action_id=a["id"],
                window_closed=window_closed,
                action_created_at=created,
            )
        )

    return out
