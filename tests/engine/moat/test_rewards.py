"""Plan 05 Task 11 — unit coverage of ``compute_reward``.

Pure function, no DB. We exercise:

    1. confirmed_loss returns the dollar impact verbatim
    2. false_positive returns the flat penalty
    3. already_handled returns zero
    4. boundary: negative dollar_impact on confirmed_loss is clamped
       to zero (we never want a "negative confirmed loss" to invert
       the sign and reward false positives).
"""

from __future__ import annotations

from decimal import Decimal

from calderyn_engine.moat.rewards import FALSE_POSITIVE_PENALTY, compute_reward


def test_confirmed_loss_returns_impact_as_decimal() -> None:
    reward = compute_reward("confirmed_loss", Decimal("1500"), days_to_confirm=2)
    assert reward == Decimal("1500")


def test_false_positive_returns_flat_penalty() -> None:
    reward = compute_reward("false_positive", Decimal("999"), days_to_confirm=0)
    assert reward == FALSE_POSITIVE_PENALTY
    assert reward == Decimal("-10")


def test_already_handled_returns_zero() -> None:
    reward = compute_reward("already_handled", Decimal("500"), days_to_confirm=5)
    assert reward == Decimal("0")


def test_confirmed_loss_negative_impact_is_clamped_to_zero() -> None:
    # Defensive boundary: a malformed event_log row could carry a
    # negative dollar_impact. The trainer should treat that as no
    # signal, not as "−$100 of confirmed loss".
    reward = compute_reward("confirmed_loss", Decimal("-100"), days_to_confirm=1)
    assert reward == Decimal("0")
