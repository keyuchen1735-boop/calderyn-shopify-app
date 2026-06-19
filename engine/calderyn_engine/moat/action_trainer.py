"""D3 — nightly autopilot action trainer (spec §5, §3). Seeds a Beta prior from
the peer action-baseline, folds the shop's own action rewards, maps the posterior
mean to mu in [0,1] (fraction-space rescale: cold start -> p50), upserts
moat.action_models keyed by pseudonym (A4). Reuses update_threshold + pseudonym_for.
Mirrors threshold_trainer: cohort enumeration, per-(shop,group) short transaction,
fail-visible, pooler-safe.
"""
from __future__ import annotations
import json, math
from datetime import date
from decimal import Decimal
from typing import Any, TypedDict

import structlog
from calderyn_engine.moat.pseudonym import pseudonym_for
from calderyn_engine.moat.threshold_updater import update_threshold
from calderyn_engine.moat.peer_incident_etl import gmv_band_for_shop
from calderyn_engine.moat.action_reward_inputs import derive_action_reward_inputs

logger = structlog.get_logger()
BASE_STRENGTH, CONTRIB_WEIGHT, LEARNING_RATE = 2.0, 1.0, 0.1

def _seed_prior(baseline: dict | None) -> dict[str, float]:
    if baseline is None:
        return {"alpha": 1.0, "beta": 1.0, "n_peers": 0, "seeded_from": "flat_default"}
    n = int(baseline["n"])
    s0 = BASE_STRENGTH + CONTRIB_WEIGHT * math.log(1 + n)
    half = s0 / 2.0
    return {"alpha": half, "beta": half, "n_peers": n, "seeded_from": "peer_baseline"}

def _mu_from_posterior(posterior: dict, baseline: dict | None) -> float:
    a, b = float(posterior.get("alpha", 1.0)), float(posterior.get("beta", 1.0))
    m = a / (a + b) if (a + b) > 0 else 0.5
    if baseline is None:
        return 1.0  # no peer signal -> full merchant cap (today's behavior)
    p25, p50, p75 = (Decimal(str(baseline[k])) for k in ("p25", "p50", "p75"))
    md, half = Decimal(str(m)), Decimal("0.5")
    if md >= half:
        thr = p50 - (md - half) / half * (p50 - p25)
    else:
        thr = p50 + (half - md) / half * (p75 - p50)
    return float(max(Decimal("0"), min(thr, Decimal("1"))))

async def _read_baseline(conn: Any, segment: str, detector_id: str, action_kind: str) -> dict | None:
    row = await conn.fetchrow(
        "SELECT p25,p50,p75,n FROM moat.action_baselines "
        "WHERE segment=$1 AND detector_id=$2 AND action_kind=$3", segment, detector_id, action_kind)
    return dict(row) if row else None

async def _upsert(conn: Any, detector_id: str, action_kind: str, shop_id: str, pepper: str,
                  posterior: dict, mu: float) -> None:
    await conn.execute(
        """
        INSERT INTO moat.action_models (detector_id, action_kind, shop_id_pseudonym, policy_json, posterior_json, updated_at)
        VALUES ($1,$2,$3,$4::jsonb,$5::jsonb, now())
        ON CONFLICT (detector_id, action_kind, shop_id_pseudonym) DO UPDATE SET
          policy_json=EXCLUDED.policy_json, posterior_json=EXCLUDED.posterior_json, updated_at=EXCLUDED.updated_at
        """,
        detector_id, action_kind, pseudonym_for(shop_id, pepper),
        json.dumps({"mu": mu}), json.dumps(posterior))

async def _coldstart_keys(conn: Any, segment: str) -> list[tuple[str, str]]:
    rows = await conn.fetch("SELECT detector_id, action_kind FROM moat.action_baselines WHERE segment=$1", segment)
    return [(r["detector_id"], r["action_kind"]) for r in rows]

class ActionTrainSummary(TypedDict):
    shops_trained: int
    models_written: int
    skipped: int
    errors: list[str]

async def train_action_policies(conn: Any, *, pepper: str, run_date: date,
                                learning_rate: float = LEARNING_RATE) -> ActionTrainSummary:
    s: ActionTrainSummary = {"shops_trained": 0, "models_written": 0, "skipped": 0, "errors": []}
    shop_rows = await conn.fetch(
        "SELECT DISTINCT s.id::text AS shop_id FROM public.shops s "
        "LEFT JOIN public.action_audit a ON a.shop_id = s.id AND a.actor_user_id='autopilot' "
        "WHERE s.peer_data_consent = true OR a.shop_id IS NOT NULL")
    for sr in shop_rows:
        shop_id = sr["shop_id"]
        try:
            rewards = await derive_action_reward_inputs(conn, shop_id, run_date)
        except Exception as exc:  # noqa: BLE001
            # Full detail to the structured log channel; the RETURNED summary keeps
            # only the exception class so no DB-internal text (which an asyncpg error
            # can carry) leaks into a persisted/echoed summary. shop_id stays raw:
            # it is the shop's OWN training error (invariant A5) on a CRON_SECRET-
            # auth'd internal channel, and the operator needs it to act.
            logger.error("train_shop_reward_read_failed", shop_id=shop_id,
                         error=str(exc), exc_type=type(exc).__name__)
            s["skipped"] += 1; s["errors"].append(f"{shop_id}/*: reward read failed ({type(exc).__name__})"); continue
        by_group: dict[tuple[str, str], list] = {}
        for r in rewards:
            by_group.setdefault((r["detector_id"], r["action_kind"]), []).append(r)
        trained_any = False
        segment = await gmv_band_for_shop(conn, shop_id, run_date)
        keys = set(by_group) | set(await _coldstart_keys(conn, segment))
        for (detector_id, action_kind) in keys:
            try:
                async with conn.transaction():
                    baseline = await _read_baseline(conn, segment, detector_id, action_kind)
                    group = by_group.get((detector_id, action_kind), [])
                    if baseline is None and not group:
                        continue
                    posterior = _seed_prior(baseline)
                    for r in sorted(group, key=lambda x: x["action_id"]):
                        posterior = update_threshold(posterior, r["reward"], learning_rate=learning_rate)
                    posterior["n_events"] = len(group)
                    posterior["last_reward"] = float(group[-1]["reward"]) if group else 0.0
                    await _upsert(conn, detector_id, action_kind, shop_id, pepper, posterior, _mu_from_posterior(posterior, baseline))
            except Exception as exc:  # noqa: BLE001
                logger.error("train_group_failed", shop_id=shop_id, detector_id=detector_id,
                             action_kind=action_kind, error=str(exc), exc_type=type(exc).__name__)
                s["skipped"] += 1
                s["errors"].append(f"{shop_id}/{detector_id}/{action_kind}: {type(exc).__name__}"); continue
            s["models_written"] += 1; trained_any = True
        if trained_any:
            s["shops_trained"] += 1
    logger.info("train_action_policies_complete", shops_trained=s["shops_trained"],
                models_written=s["models_written"], skipped=s["skipped"], error_count=len(s["errors"]))
    return s
