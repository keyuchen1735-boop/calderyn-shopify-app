"""Plan 05 Task 12 — Bayesian posterior updater for the threshold trainer.

``update_threshold`` is the math kernel of the moat threshold trainer:
given the current Beta-distribution posterior over "is this alert
worth firing?" and one new reward signal, return the updated
posterior. Pure function — no DB, no I/O, no clock — so the trainer's
behaviour is reproducible from the event_log alone (acceptance test
in Task 23).

The posterior is a dict ``{"alpha": float, "beta": float}`` shaped
that way so it round-trips through ``moat.detection_models.posterior_json``
without any custom codec.

Update rule (per Plan 05 lines 893–960):

* Positive reward shifts ``alpha`` upward (alerts are useful → loosen
  the threshold so more fire).
* Negative reward shifts ``beta`` upward (alerts are noisy → tighten
  the threshold).
* Zero reward leaves both unchanged (no signal → no movement).
* The ``learning_rate`` scales how aggressively each event moves the
  posterior — small enough that one outlier doesn't dominate, big
  enough that 50 events make a noticeable shift.

The function is idempotent on a zero-reward signal (case 4 below):
calling it with reward=0 returns a posterior equal to the prior.
"""

from __future__ import annotations

from decimal import Decimal
from collections.abc import Mapping


def update_threshold(
    prior_posterior: Mapping[str, float],
    reward: Decimal | float | int,
    learning_rate: float = 0.1,
) -> dict[str, float]:
    """Apply one reward signal to the Beta posterior.

    Parameters
    ----------
    prior_posterior:
        Current posterior. Must contain ``alpha`` and ``beta`` keys
        (floats); any other keys are passed through unchanged so the
        trainer can park metadata (e.g. last-update timestamp,
        sample count) in the same JSON blob without round-tripping
        through this function.
    reward:
        Scalar from :func:`calderyn_engine.moat.rewards.compute_reward`.
        Positive → useful alert, negative → noisy alert, zero → no
        signal. Coerced to ``float`` for the multiply.
    learning_rate:
        Multiplier applied to the reward magnitude before adding to
        alpha or beta. Default ``0.1`` is intentionally small — the
        trainer batches dozens of events per shop nightly, so even
        small per-event nudges accumulate. Trainer callers can dial
        this up to 0.5 for fast convergence in tests.

    Returns
    -------
    dict[str, float]
        New posterior with updated ``alpha`` / ``beta`` and any other
        prior keys preserved.
    """

    # Defensive copy so callers can keep using the prior dict.
    next_posterior: dict[str, float] = dict(prior_posterior)

    # Coerce to float once. Decimal arithmetic would be more precise,
    # but the posterior is fundamentally a statistical estimate — we
    # don't need cent-level precision here, and asyncpg's jsonb codec
    # round-trips floats more cheaply than Decimals.
    reward_f = float(reward)

    if reward_f == 0:
        # Idempotent on zero signal — explicit early-return so the
        # caller can distinguish "no movement" from "tiny movement".
        return next_posterior

    alpha = float(next_posterior.get("alpha", 1.0))
    beta = float(next_posterior.get("beta", 1.0))

    if reward_f > 0:
        # Positive reward → alpha bump proportional to magnitude.
        alpha += learning_rate * reward_f
    else:
        # Negative reward → beta bump proportional to |magnitude|.
        beta += learning_rate * abs(reward_f)

    # Both Beta parameters must stay strictly positive — pin a small
    # floor so a degenerate prior (alpha=0 or beta=0 from a bad seed)
    # can't produce a posterior that breaks downstream sampling.
    next_posterior["alpha"] = max(alpha, 1e-6)
    next_posterior["beta"] = max(beta, 1e-6)
    return next_posterior
