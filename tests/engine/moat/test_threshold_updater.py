"""Plan 05 Task 12 — unit coverage of ``update_threshold``.

Pure function, no DB. Covers:

    1. Positive reward shifts alpha upward (and leaves beta alone).
    2. Negative reward shifts beta upward (and leaves alpha alone).
    3. Larger learning_rate produces a larger shift for the same reward.
    4. Edge case: zero reward yields a posterior equal to the prior.
    5. Idempotent on no-signal: applying zero reward N times still
       equals the prior (proves no hidden state mutation).
"""

from __future__ import annotations

from decimal import Decimal

from calderyn_engine.moat.threshold_updater import update_threshold


def test_positive_reward_shifts_alpha_up() -> None:
    prior = {"alpha": 1.0, "beta": 1.0}
    new = update_threshold(prior, reward=Decimal("100"), learning_rate=0.1)
    # alpha = 1 + 0.1 * 100 = 11
    assert new["alpha"] > prior["alpha"]
    assert new["beta"] == prior["beta"]


def test_negative_reward_shifts_beta_up() -> None:
    prior = {"alpha": 1.0, "beta": 1.0}
    new = update_threshold(prior, reward=Decimal("-10"), learning_rate=0.1)
    # beta = 1 + 0.1 * 10 = 2
    assert new["beta"] > prior["beta"]
    assert new["alpha"] == prior["alpha"]


def test_learning_rate_scales_effect() -> None:
    prior = {"alpha": 1.0, "beta": 1.0}
    slow = update_threshold(prior, reward=Decimal("100"), learning_rate=0.01)
    fast = update_threshold(prior, reward=Decimal("100"), learning_rate=0.5)
    # Both move alpha up; faster rate moves it more.
    assert fast["alpha"] > slow["alpha"] > prior["alpha"]


def test_zero_reward_returns_prior() -> None:
    # Zero signal — posterior must equal prior, including any extra
    # metadata keys the trainer parked in the dict.
    prior = {"alpha": 2.5, "beta": 4.0, "last_update_ts": 1700000000.0}
    new = update_threshold(prior, reward=Decimal("0"), learning_rate=0.5)
    assert new == prior
    # Defensive copy: mutating the result must not touch the prior.
    new["alpha"] = 999.0
    assert prior["alpha"] == 2.5


def test_idempotent_on_repeated_no_signal() -> None:
    prior = {"alpha": 3.0, "beta": 5.0}
    cur = dict(prior)
    for _ in range(10):
        cur = update_threshold(cur, reward=Decimal("0"))
    assert cur == prior
