"""Plan 05 Task 11 — pure reward calculator for the moat threshold trainer.

``compute_reward`` collapses a single (feedback_kind, dollar_impact,
days_to_confirm) tuple into the scalar reward signal the threshold
updater (Task 12) feeds into the Bayesian posterior. Pure function:
no DB, no clock, no I/O — Decimal in, Decimal out — so the trainer's
behaviour is fully reproducible from event_log rows alone.

Reward semantics (per Plan 05 lines 836–880):

* ``confirmed_loss`` → ``+dollar_impact`` (the alert was real and we
  saved that much money). Days-to-confirm is intentionally NOT used
  to scale the magnitude here — the trainer's posterior decay handles
  recency. We do, however, clamp at zero because Decimal('-0') from a
  negative impact would silently invert the reward sign.

* ``false_positive`` → ``-10`` (a flat penalty, not proportional to
  the bogus dollar figure — penalising magnitude would teach the
  trainer "cry wolf about small numbers" which is worse than noise).

* ``already_handled`` → ``0`` (merchant resolved it without our
  alert, but the alert wasn't wrong; it just wasn't actionable).

The reward magnitudes here are the contract Task 12 reads — changing
them changes the trainer's converged thresholds, so any tweak needs
to land alongside an updated test fixture in
``apps/engine/tests/moat/test_threshold_updater.py``.
"""

from __future__ import annotations

from decimal import Decimal

# Flat false-positive penalty. Big enough that a single false positive
# undoes ten $1 confirmed losses; small enough that a single confirmed
# $10K loss still moves the posterior. Tune in lockstep with Task 12's
# learning_rate.
FALSE_POSITIVE_PENALTY: Decimal = Decimal("-10")


def compute_reward(
    feedback_kind: str,
    dollar_impact: Decimal | int | float,
    days_to_confirm: int,
) -> Decimal:
    """Return the scalar reward for one feedback row.

    Parameters
    ----------
    feedback_kind:
        One of ``'confirmed_loss'``, ``'false_positive'``,
        ``'already_handled'``.
    dollar_impact:
        Detector-estimated dollar impact at alert time (USD). Coerced
        to ``Decimal`` so callers can pass int/float literals from
        test fixtures without losing precision.
    days_to_confirm:
        How many days between alert and merchant confirmation. Not
        used in the v1 formula but kept in the signature so adding
        recency decay later doesn't churn callers.

    Returns
    -------
    Decimal
        The reward — positive for confirmed loss, negative for false
        positive, zero for already-handled or unknown kind.
    """

    # Coerce to Decimal once at the top so all downstream arithmetic
    # is exact. ``str(value)`` handles float/int/Decimal alike.
    impact = Decimal(str(dollar_impact))

    if feedback_kind == "confirmed_loss":
        # Negative impact would invert the sign and teach the trainer
        # "false positives are good" — clamp to zero defensively.
        if impact < 0:
            return Decimal("0")
        # days_to_confirm is reserved for future recency-weighting; the
        # current formula treats all confirmations equally.
        _ = days_to_confirm
        return impact

    if feedback_kind == "false_positive":
        return FALSE_POSITIVE_PENALTY

    if feedback_kind == "already_handled":
        return Decimal("0")

    # Unknown kind — no signal. We deliberately don't raise here:
    # the trainer reads from event_log which is permissively typed
    # at the JSON level, and a future kind appearing in production
    # before this code rolls out should degrade to "no signal" rather
    # than crash the trainer for every shop.
    return Decimal("0")
