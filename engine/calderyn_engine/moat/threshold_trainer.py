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
from datetime import date
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


# --- cohort trainer (umbrella section 9.3 — authoritative entrypoint) -----
#
# ``gmv_band_for_shop`` (peer_incident_etl) and ``_DETECTOR_THRESHOLDS``
# (thresholds) have no import cycle with this module, so they are imported
# directly. ``derive_reward_inputs`` (the #2 producer) is the exception: that
# module imports ``RewardInput`` FROM this one, so importing it at module load
# here — in either order — is a hard circular import. It is therefore bound
# lazily (see ``_derive_reward_inputs``) on first call. The module-level
# ``derive_reward_inputs = None`` sentinel doubles as the monkeypatch seam:
# a test can ``setattr(threshold_trainer, "derive_reward_inputs", fake)`` and
# the lazy loader will honour the override instead of importing.
from collections.abc import Sequence  # noqa: E402

import structlog  # noqa: E402

from calderyn_engine.moat.peer_incident_etl import gmv_band_for_shop  # noqa: E402
from calderyn_engine.thresholds import _DETECTOR_THRESHOLDS  # noqa: E402

logger = structlog.get_logger()

# Lazily-bound seam to the #2 producer (broken out of the import cycle). Tests
# may override this attribute directly to inject a per-shop reward failure.
derive_reward_inputs = None


async def _derive_reward_inputs(conn: Any, shop_id: str) -> list[RewardInput]:
    """Resolve and call the #2 reward producer, honouring a test override.

    If ``derive_reward_inputs`` was monkeypatched on this module, use it as
    is. Otherwise import the real producer lazily (avoiding the module-load
    cycle) and cache it on the module so subsequent calls skip the import.
    """
    fn = derive_reward_inputs
    if fn is None:
        from calderyn_engine.moat.reward_inputs import (
            derive_reward_inputs as _real,
        )

        globals()["derive_reward_inputs"] = _real
        fn = _real
    return list(await fn(conn, shop_id))


class TrainSummary(TypedDict):
    """Per-night cohort trainer outcome (slice #4 surfaces non-empty errors)."""

    shops_trained: int
    models_written: int
    skipped: int
    errors: list[str]


async def _cohort_shop_ids(conn: Any) -> Sequence[str]:
    """Enumerate the training cohort from ``public.shops``.

    Cohort = every shop that EITHER granted ``peer_data_consent`` OR has at
    least one ``alert_feedback`` row (umbrella section 4.2 + task). A
    consenting shop with no feedback is still in-cohort so the cold-start
    pass can seed it from the peer baseline; a non-consenting shop with no
    feedback is excluded entirely (it contributes no signal and gets no
    model). ``DISTINCT`` collapses the fan-out from the feedback join.
    """
    rows = await conn.fetch(
        """
        SELECT DISTINCT s.id::text AS shop_id
          FROM public.shops s
          LEFT JOIN public.alert_feedback af ON af.shop_id = s.id
         WHERE s.peer_data_consent = true
            OR af.shop_id IS NOT NULL
        """
    )
    return [r["shop_id"] for r in rows]


async def train_thresholds(
    conn: Any,
    *,
    pepper: str,
    run_date: date,
    learning_rate: float = LEARNING_RATE,
) -> TrainSummary:
    """Nightly cohort trainer entrypoint (umbrella section 9.3).

    Enumerates the cohort itself, then for each (shop, detector in
    ``_DETECTOR_THRESHOLDS``):

      1. ``segment = gmv_band_for_shop(conn, shop, run_date)`` — the shared
         resolver slice #5 also writes baselines under, so the prior matches.
      2. ``baseline = _read_peer_baseline(conn, detector, segment)``.
      3. ``rewards`` = this shop's ``derive_reward_inputs`` rows for THAT
         detector (own raw data, invariant A5).
      4. ``_fold_group`` seeds the prior from the baseline and folds the
         rewards; ``_upsert_model`` writes the pseudonym-keyed row (A4).

    COLD START (section 4.2): a consenting shop with NO feedback for a
    detector still gets a row — empty rewards make ``_fold_group`` return the
    seeded prior (mean 0.5 -> exactly the peer median), strictly better than
    the static default. The only (shop, detector) pair that writes nothing is
    one with NO baseline AND NO rewards (nothing to learn from).

    Pooler-safe (transaction pooler, port 6543): each (shop, detector)
    read+upsert runs in its OWN short ``conn.transaction()`` so the
    read-then-write invariant never splits across pgbouncer backends; there
    is no mega-transaction. Fail-visible (rule 12): a per-(shop, detector)
    exception is caught, recorded in ``errors`` and counted in ``skipped``,
    and NEVER aborts the rest of the run.

    A shop's reward rows are read ONCE (one query for all its detectors) and
    bucketed by ``detector_id`` in memory, so the per-detector loop issues no
    extra reward queries. A whole-shop failure (e.g. the reward read itself
    raising) is attributed to every detector for that shop so the night's
    error tally never silently under-counts.
    """
    summary: TrainSummary = {
        "shops_trained": 0,
        "models_written": 0,
        "skipped": 0,
        "errors": [],
    }

    shop_ids = await _cohort_shop_ids(conn)

    for shop_id in shop_ids:
        # Read this shop's own reward signal once, then bucket by detector.
        # A failure here is not silently dropped: it is charged against every
        # detector this shop would have trained (rule 12).
        try:
            rows = await _derive_reward_inputs(conn, shop_id)
        except Exception as exc:  # noqa: BLE001
            logger.error(
                "train_shop_reward_read_failed",
                shop_id=shop_id,
                error=str(exc),
                exc_type=type(exc).__name__,
            )
            summary["skipped"] += len(_DETECTOR_THRESHOLDS)
            summary["errors"].append(
                f"{shop_id}/*: reward read failed: {exc}"
            )
            continue

        rewards_by_detector: dict[str, list[RewardInput]] = {}
        for r in rows:
            rewards_by_detector.setdefault(r["detector_id"], []).append(r)

        trained_any = False
        for detector_id, (canonical_key, default_usd) in _DETECTOR_THRESHOLDS.items():
            group_rows = rewards_by_detector.get(detector_id, [])
            try:
                # One short transaction per (shop, detector) — pooler-safe.
                async with conn.transaction():
                    segment = await gmv_band_for_shop(conn, shop_id, run_date)
                    baseline = await _read_peer_baseline(
                        conn, detector_id, segment
                    )
                    # Nothing to learn from: no peer prior AND no own feedback.
                    # Skip silently (not an error) so we never write a row that
                    # would just echo the static default.
                    if baseline is None and not group_rows:
                        continue
                    posterior_json, threshold_json = _fold_group(
                        group_rows,
                        baseline,
                        canonical_key,
                        default_usd,
                        learning_rate,
                    )
                    await _upsert_model(
                        conn,
                        detector_id,
                        shop_id,
                        posterior_json,
                        threshold_json,
                        pepper,
                    )
            except Exception as exc:  # noqa: BLE001
                logger.error(
                    "train_group_failed",
                    shop_id=shop_id,
                    detector_id=detector_id,
                    error=str(exc),
                    exc_type=type(exc).__name__,
                )
                summary["skipped"] += 1
                summary["errors"].append(f"{shop_id}/{detector_id}: {exc}")
                continue
            summary["models_written"] += 1
            trained_any = True

        if trained_any:
            summary["shops_trained"] += 1

    logger.info(
        "train_thresholds_complete",
        run_date=run_date.isoformat(),
        shops_trained=summary["shops_trained"],
        models_written=summary["models_written"],
        skipped=summary["skipped"],
        error_count=len(summary["errors"]),
    )
    return summary
