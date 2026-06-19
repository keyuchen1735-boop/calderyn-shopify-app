"""D2 — anonymized peer baselines of WINNING action aggressiveness (spec §6).

For every consenting shop (shops.peer_data_consent), bucket its positively-
rewarded autopilot actions by (segment, detector, action_kind), keep the
aggressiveness fraction chosen_pct/cap, and publish p25/p50/p75 ONLY when >= 5
DISTINCT shops contributed (A3). Aggregates only across pseudonymous contributors
(A1, A2). Mirrors peer_incident_etl.
"""
from __future__ import annotations

import statistics
from datetime import date
from typing import Any, TypedDict

from calderyn_engine.moat.action_reward_inputs import derive_action_reward_inputs
from calderyn_engine.moat.peer_incident_etl import gmv_band_for_shop

MIN_CONTRIBUTORS = 5


class ActionEtlSummary(TypedDict):
    baselines_written: int
    groups_suppressed: int


async def _consenting_shop_ids(conn: Any) -> list[str]:
    rows = await conn.fetch(
        "SELECT id::text AS shop_id FROM public.shops WHERE peer_data_consent = true"
    )
    return [r["shop_id"] for r in rows]


async def _caps(conn: Any, shop_id: str) -> dict[str, float]:
    row = await conn.fetchrow(
        "SELECT autopilot_max_budget_cut_pct, autopilot_max_budget_increase_pct "
        "FROM public.guardrail_config WHERE shop_id = $1",
        shop_id,
    )
    cut = float(row["autopilot_max_budget_cut_pct"]) if row else 50.0
    inc = float(row["autopilot_max_budget_increase_pct"]) if row else 20.0
    return {
        "reduce_campaign_budget": cut,
        "reallocate_budget": cut,
        "increase_campaign_budget": inc,
        "pause_campaign": 100.0,
    }


async def run_action_peer_etl(
    conn: Any, *, pepper: str, run_date: date
) -> ActionEtlSummary:
    """Aggregate winning-action aggressiveness fractions across consenting shops.

    Invariants:
      A2 — only shops with peer_data_consent=true contribute.
      A3 — a (segment, detector_id, action_kind) group is published only when
           >= MIN_CONTRIBUTORS (5) distinct shops contributed.

    Parameters
    ----------
    conn:
        asyncpg connection (or compatible). Caller owns transaction scope.
    pepper:
        HMAC pepper (accepted for interface parity with other ETL entry-points;
        not used in this slice because we aggregate at the shop level, not
        pseudonym level — the raw shop_id never leaves this function).
    run_date:
        Logical run date, forwarded to derive_action_reward_inputs and
        gmv_band_for_shop.

    Returns
    -------
    ActionEtlSummary
        ``baselines_written``: groups that met the k-floor and were upserted.
        ``groups_suppressed``: groups that fell below the k-floor (no row written).
    """
    # groups maps (segment, detector_id, action_kind) ->
    #   {"fracs": list[float], "shops": set[str]}
    groups: dict[tuple[str, str, str], dict[str, Any]] = {}

    for shop_id in await _consenting_shop_ids(conn):
        segment = await gmv_band_for_shop(conn, shop_id, run_date)
        cap_map = await _caps(conn, shop_id)
        for r in await derive_action_reward_inputs(conn, shop_id, run_date):
            if r["reward"] <= 0:
                continue  # only positively-rewarded (winning) actions inform the prior
            cap = cap_map.get(r["action_kind"], 100.0) or 100.0
            frac = min(max(r["chosen_pct"] / cap, 0.0), 1.0)
            key = (segment, r["detector_id"], r["action_kind"])
            g = groups.setdefault(key, {"fracs": [], "shops": set()})
            g["fracs"].append(frac)
            g["shops"].add(shop_id)

    written = suppressed = 0
    for (segment, detector_id, action_kind), g in groups.items():
        n = len(g["shops"])
        if n < MIN_CONTRIBUTORS:
            suppressed += 1
            continue
        fr = sorted(g["fracs"])
        # statistics.quantiles(data, n=4) returns [Q1, Q2, Q3] for any list
        # length >= 1 (verified: identical values produce [v, v, v] cleanly).
        q = statistics.quantiles(fr, n=4)
        await conn.execute(
            """
            INSERT INTO moat.action_baselines
              (segment, detector_id, action_kind, p25, p50, p75, n, updated_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7, now())
            ON CONFLICT (segment, detector_id, action_kind) DO UPDATE SET
              p25=EXCLUDED.p25, p50=EXCLUDED.p50, p75=EXCLUDED.p75,
              n=EXCLUDED.n, updated_at=EXCLUDED.updated_at
            """,
            segment, detector_id, action_kind, q[0], q[1], q[2], n,
        )
        written += 1
    return ActionEtlSummary(baselines_written=written, groups_suppressed=suppressed)


__all__ = [
    "MIN_CONTRIBUTORS",
    "ActionEtlSummary",
    "run_action_peer_etl",
]
