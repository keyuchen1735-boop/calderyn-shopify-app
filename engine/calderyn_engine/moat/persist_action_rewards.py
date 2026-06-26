"""Persist per-action reward signs back to action_audit once their per-kind
confirmation window has closed (design 2026-06-26 §4). This is the seam the
TypeScript calibration recompute reads — the engine computes the dollar outcome,
records reward_signal + reward_window_closed_at, and the trust layer tallies it.

Idempotent: only rows whose window has closed AND that have not yet been written
(reward_window_closed_at is null) are updated. Own raw data only (invariant A5).
"""
from __future__ import annotations
from datetime import date

from calderyn_engine.moat.action_reward_inputs import derive_action_reward_inputs

_UPDATE_SQL = """
UPDATE public.action_audit
   SET reward_signal = $2,
       reward_window_closed_at = now()
 WHERE id = $1
   AND shop_id = $3
   AND reward_window_closed_at IS NULL
"""


async def persist_action_rewards(conn, shop_id: str, run_date: date) -> int:
    """Write reward_signal for every closed-window, unpersisted autopilot action.

    Returns the number of action_audit rows updated.
    """
    written = 0
    for r in await derive_action_reward_inputs(conn, shop_id, run_date):
        if not r["window_closed"]:
            continue
        await conn.execute(_UPDATE_SQL, r["action_id"], r["reward"], shop_id)
        written += 1
    return written
