"""Slice #3 — nightly threshold trainer (empirical-Bayes prior seeding).

Turns per-(shop, detector) reward inputs (slice #2) + anonymized peer
baselines (slice #5) into moat.detection_models rows. THE moat mechanism:
each posterior's prior (alpha0, beta0) is seeded from the peer baseline for
the shop's segment, NOT a flat (1,1); the shop's own compute_reward signal
then shrinks the published threshold away from peer consensus.

See docs/superpowers/specs/2026-06-16-moat-threshold-trainer-spec.md and
the umbrella docs/superpowers/specs/2026-06-16-moat-loop-closure-design.md.
Reuses the existing kernels: update_threshold, compute_reward,
pseudonym_for. Adds no migration; edits no other module. pgbouncer
TRANSACTION-pooler safe: each group's read+upsert is one short atomic
statement; no cross-statement session state.
"""

from __future__ import annotations

import json
import math
from decimal import Decimal
from typing import Any, TypedDict

import asyncpg  # noqa: F401  (type only; conn is asyncpg.Connection)

from calderyn_engine.moat.pseudonym import pseudonym_for
from calderyn_engine.moat.rewards import compute_reward
from calderyn_engine.moat.threshold_updater import update_threshold


class PeerBaseline(TypedDict):
    p25: Decimal
    p50: Decimal
    p75: Decimal
    n: int


class RewardInput(TypedDict):
    shop_id: str
    detector_id: str
    feedback_kind: str
    dollar_impact: Decimal
    days_to_confirm: int
    alert_id: str


# --- moat math constants (spec section 4) --------------------------------
LEARNING_RATE: float = 0.1          # matches update_threshold default
BASE_STRENGTH: float = 2.0          # prior pseudo-count floor
CONTRIB_WEIGHT: float = 1.0         # ln(1+n) weight on peer confidence
EPS: Decimal = Decimal("1")         # IQR floor (avoid /0 on degenerate cohort)
THRESH_FLOOR: Decimal = Decimal("0")
THRESH_CEIL_MULT: Decimal = Decimal("3")   # cap published threshold at 3*p75


def _seed_prior(baseline: PeerBaseline | None) -> dict[str, float]:
    """Empirical-Bayes prior (alpha0, beta0) from the peer baseline.

    Symmetric Beta centred on the peer median (mean 0.5) with strength
    rising in the contributor count: s0 = BASE_STRENGTH + CONTRIB_WEIGHT*
    ln(1+n). alpha0 = beta0 = s0/2. None -> flat (1,1) default.
    """
    if baseline is None:
        return {"alpha": 1.0, "beta": 1.0, "n_peers": 0, "seeded_from": "flat_default"}
    n = int(baseline["n"])
    s0 = BASE_STRENGTH + CONTRIB_WEIGHT * math.log(1 + n)
    half = s0 / 2.0
    return {"alpha": half, "beta": half, "n_peers": n, "seeded_from": "peer_baseline"}


def _rescale(
    posterior: dict[str, float],
    baseline: PeerBaseline | None,
    canonical_key: str,
    default_usd: Decimal,
) -> dict[str, float]:
    """Map the posterior mean back onto the peer dollar band (spec 4.3).

    Piecewise-linear, anchored on all three quartiles so cold-start
    (mean 0.5) lands EXACTLY on p50 (the peer consensus threshold):

        mu >= 0.5:  p50 - (mu-0.5)/0.5 * (p50-p25)     # mu:0.5->1 maps p50->p25 (loosen)
        mu  < 0.5:  p50 + (0.5-mu)/0.5 * (p75-p50)     # mu:0.5->0 maps p50->p75 (tighten)

    No baseline -> static per-detector default. Result clamped to
    [THRESH_FLOOR, THRESH_CEIL_MULT * p75].
    """
    if baseline is None:
        return {canonical_key: float(default_usd)}

    alpha = float(posterior.get("alpha", 1.0))
    beta = float(posterior.get("beta", 1.0))
    mu = alpha / (alpha + beta) if (alpha + beta) > 0 else 0.5

    p25 = baseline["p25"]
    p50 = baseline["p50"]
    p75 = baseline["p75"]
    mu_d = Decimal(str(mu))
    half = Decimal("0.5")

    if mu_d >= half:
        thr = p50 - (mu_d - half) / half * (p50 - p25)
    else:
        thr = p50 + (half - mu_d) / half * (p75 - p50)

    ceil = THRESH_CEIL_MULT * p75
    thr = max(THRESH_FLOOR, min(thr, ceil))
    return {canonical_key: float(thr.quantize(Decimal("0.01")))}


def _fold_group(
    rows: list[RewardInput],
    baseline: PeerBaseline | None,
    canonical_key: str,
    default_usd: Decimal,
    learning_rate: float,
) -> tuple[dict[str, float], dict[str, float]]:
    """Seed from baseline, fold each reward, rescale to threshold_json.

    Rows are folded in ascending alert_id order so a re-run over the same
    inputs is byte-identical (idempotence). Returns
    (posterior_json, threshold_json).
    """
    posterior = _seed_prior(baseline)
    ordered = sorted(rows, key=lambda r: r["alert_id"])
    last_reward = 0.0
    for r in ordered:
        reward = compute_reward(
            r["feedback_kind"], r["dollar_impact"], r["days_to_confirm"]
        )
        posterior = update_threshold(posterior, reward, learning_rate=learning_rate)
        last_reward = float(reward)
    posterior["n_events"] = len(ordered)
    posterior["last_reward"] = last_reward
    threshold_json = _rescale(posterior, baseline, canonical_key, default_usd)
    return posterior, threshold_json


async def _read_peer_baseline(
    conn: Any, detector_id: str, segment: str
) -> PeerBaseline | None:
    """Single SELECT of the (detector_id, segment) baseline. None if absent.

    Any row returned is already k>=5 floored upstream (invariant A3) — the
    trainer never re-checks k here.
    """
    row = await conn.fetchrow(
        "SELECT p25, p50, p75, n FROM moat.peer_baselines "
        "WHERE detector_id = $1 AND segment = $2",
        detector_id,
        segment,
    )
    if row is None:
        return None
    return {
        "p25": Decimal(str(row["p25"])),
        "p50": Decimal(str(row["p50"])),
        "p75": Decimal(str(row["p75"])),
        "n": int(row["n"]),
    }


async def _upsert_model(
    conn: Any,
    detector_id: str,
    shop_id: str,
    posterior_json: dict[str, float],
    threshold_json: dict[str, float],
    pepper: str,
) -> None:
    """Upsert one detection_models row keyed by the shop's pseudonym (A4).

    Single atomic INSERT ... ON CONFLICT DO UPDATE — correct under the
    transaction pooler with no session-state assumptions.
    """
    pseudonym = pseudonym_for(shop_id, pepper)
    await conn.execute(
        """
        INSERT INTO moat.detection_models
          (detector_id, shop_id_pseudonym, threshold_json, posterior_json, updated_at)
        VALUES ($1, $2, $3::jsonb, $4::jsonb, now())
        ON CONFLICT (detector_id, shop_id_pseudonym) DO UPDATE SET
          threshold_json = EXCLUDED.threshold_json,
          posterior_json = EXCLUDED.posterior_json,
          updated_at     = EXCLUDED.updated_at
        """,
        detector_id,
        pseudonym,
        json.dumps(threshold_json),
        json.dumps(posterior_json),
    )
