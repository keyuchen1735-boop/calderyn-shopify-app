"""Slice #3 (tracer) — pure-Python tests for the moat threshold trainer.

No DB. Covers the empirical-Bayes prior seed, the posterior->threshold
rescale (cold-start lands exactly on the peer median = the moat mechanism),
and the deterministic per-group fold. See
docs/superpowers/specs/2026-06-16-moat-threshold-trainer-spec.md.
"""
from __future__ import annotations

import math
from decimal import Decimal

import pytest

from calderyn_engine.moat.rewards import compute_reward
from calderyn_engine.moat.threshold_trainer import (
    BASE_STRENGTH,
    CONTRIB_WEIGHT,
    _fold_group,
    _rescale,
    _seed_prior,
)
from calderyn_engine.moat.threshold_updater import update_threshold

KEY = "min_spend_usd"
DEFAULT = Decimal("500")


def _baseline(p25, p50, p75, n):
    return {
        "p25": Decimal(str(p25)),
        "p50": Decimal(str(p50)),
        "p75": Decimal(str(p75)),
        "n": n,
    }


# --- _seed_prior ---------------------------------------------------------
def test_seed_prior_is_symmetric_on_the_peer_median() -> None:
    prior = _seed_prior(_baseline(200, 300, 400, 5))
    assert prior["seeded_from"] == "peer_baseline"
    expected_s0 = BASE_STRENGTH + CONTRIB_WEIGHT * math.log(1 + 5)
    assert prior["alpha"] == pytest.approx(expected_s0 / 2)
    assert prior["beta"] == pytest.approx(expected_s0 / 2)
    assert prior["alpha"] == prior["beta"]  # symmetric => cold-start mean 0.5
    assert prior["n_peers"] == 5


def test_seed_prior_strength_grows_with_contributor_count() -> None:
    small = _seed_prior(_baseline(200, 300, 400, 5))
    large = _seed_prior(_baseline(200, 300, 400, 500))
    assert large["alpha"] > small["alpha"]


def test_seed_prior_none_is_flat_default() -> None:
    prior = _seed_prior(None)
    assert prior["seeded_from"] == "flat_default"
    assert prior["alpha"] == 1.0
    assert prior["beta"] == 1.0


# --- _rescale (the moat mechanism) ---------------------------------------
def test_rescale_cold_start_equals_peer_median() -> None:
    # Zero feedback => posterior == seed (mean 0.5) => threshold == p50.
    base = _baseline(200, 300, 400, 5)
    out = _rescale(_seed_prior(base), base, KEY, DEFAULT)
    assert out[KEY] == 300.0


def test_rescale_confirmed_loss_loosens_below_consensus() -> None:
    base = _baseline(200, 300, 400, 5)
    posterior = _seed_prior(base)
    reward = compute_reward("confirmed_loss", Decimal("50"), days_to_confirm=1)
    posterior = update_threshold(posterior, reward, learning_rate=0.5)
    out = _rescale(posterior, base, KEY, DEFAULT)
    assert out[KEY] < 300.0
    assert out[KEY] >= 200.0
    assert posterior["alpha"] > posterior["beta"]


def test_rescale_false_positive_tightens_above_consensus() -> None:
    base = _baseline(200, 300, 400, 5)
    posterior = _seed_prior(base)
    reward = compute_reward("false_positive", Decimal("0"), days_to_confirm=1)
    posterior = update_threshold(posterior, reward, learning_rate=0.5)
    out = _rescale(posterior, base, KEY, DEFAULT)
    assert out[KEY] > 300.0
    assert posterior["beta"] > posterior["alpha"]


def test_rescale_no_baseline_returns_static_default() -> None:
    out = _rescale(_seed_prior(None), None, KEY, DEFAULT)
    assert out[KEY] == 500.0


def test_rescale_clamps_to_3x_p75_ceiling() -> None:
    base = _baseline(200, 300, 400, 5)
    posterior = _seed_prior(base)
    for _ in range(200):
        r = compute_reward("false_positive", Decimal("0"), days_to_confirm=1)
        posterior = update_threshold(posterior, r, learning_rate=0.5)
    out = _rescale(posterior, base, KEY, DEFAULT)
    assert out[KEY] <= 1200.0  # 3 * p75 (=400)


# --- _fold_group ---------------------------------------------------------
def _row(shop, det, kind, impact, alert):
    return {
        "shop_id": shop,
        "detector_id": det,
        "feedback_kind": kind,
        "dollar_impact": Decimal(str(impact)),
        "days_to_confirm": 1,
        "alert_id": alert,
    }


def test_fold_converges_on_50_events_alpha_over_beta() -> None:
    # 4:1 confirmed:false_positive => net-positive => alpha > beta.
    base = _baseline(200, 300, 400, 5)
    rows = []
    for i in range(50):
        kind = "false_positive" if i % 5 == 0 else "confirmed_loss"
        impact = 0 if kind == "false_positive" else 50
        rows.append(_row("shop-a", "sku_stockout_vs_spend", kind, impact, f"al-{i:03d}"))
    posterior, threshold = _fold_group(rows, base, KEY, DEFAULT, 0.1)
    assert posterior["alpha"] > posterior["beta"]
    assert posterior["n_events"] == 50
    assert posterior["seeded_from"] == "peer_baseline"
    assert KEY in threshold


def test_fold_is_deterministic_regardless_of_row_order() -> None:
    base = _baseline(200, 300, 400, 5)
    rows = [
        _row("s", "sku_stockout_vs_spend", "confirmed_loss", 40, "al-002"),
        _row("s", "sku_stockout_vs_spend", "false_positive", 0, "al-000"),
        _row("s", "sku_stockout_vs_spend", "confirmed_loss", 70, "al-001"),
    ]
    p1, t1 = _fold_group(list(rows), base, KEY, DEFAULT, 0.5)
    p2, t2 = _fold_group(list(reversed(rows)), base, KEY, DEFAULT, 0.5)
    assert p1 == p2  # sorted by alert_id internally => order-independent
    assert t1 == t2


def test_fold_unknown_kind_is_noop_signal() -> None:
    base = _baseline(200, 300, 400, 5)
    seed = _seed_prior(base)
    rows = [_row("s", "sku_stockout_vs_spend", "totally_unknown_kind", 999, "al-000")]
    posterior, _ = _fold_group(rows, base, KEY, DEFAULT, 0.5)
    assert posterior["alpha"] == seed["alpha"]
    assert posterior["beta"] == seed["beta"]
    assert posterior["n_events"] == 1
