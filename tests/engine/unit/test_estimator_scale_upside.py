"""Unit tests for ``estimate_scale_upside``.

Projected incremental contribution margin from raising a winning campaign's
daily budget, assuming ROAS holds at its current level over the horizon.
Returns DOLLARS (matching alerts.dollar_impact), rounded to cents.
"""

from decimal import Decimal

from calderyn_engine.estimators.scale_upside import estimate_scale_upside


def test_standard_winner_upside() -> None:
    # current $100/day, +20% => +$20/day incremental spend.
    # roas 3.0, margin 0.5 => net per $1 = 3.0*0.5 - 1 = 0.5.
    # 20/day * 0.5 * 30 days = $300.00.
    out = estimate_scale_upside(
        current_daily_cents=10_000,
        roas=Decimal("3.0"),
        margin=Decimal("0.5"),
        increase_pct=20,
        horizon_days=30,
    )
    assert out == Decimal("300.00")


def test_marginal_winner_floor() -> None:
    # roas 2.4, margin 0.5 => net per $1 = 0.2 (the winning floor: 1.2/margin).
    # current $50/day, +20% => $10/day. 10 * 0.2 * 30 = $60.00.
    out = estimate_scale_upside(
        current_daily_cents=5_000,
        roas=Decimal("2.4"),
        margin=Decimal("0.5"),
        increase_pct=20,
        horizon_days=30,
    )
    assert out == Decimal("60.00")


def test_never_negative() -> None:
    # A non-winner (net per $1 negative) must not produce a negative upside —
    # the detector only feeds winners, but the estimator clips defensively.
    out = estimate_scale_upside(
        current_daily_cents=10_000,
        roas=Decimal("1.0"),
        margin=Decimal("0.5"),
        increase_pct=20,
        horizon_days=30,
    )
    assert out == Decimal("0.00")


def test_zero_budget_is_zero() -> None:
    out = estimate_scale_upside(
        current_daily_cents=0,
        roas=Decimal("3.0"),
        margin=Decimal("0.5"),
        increase_pct=20,
        horizon_days=30,
    )
    assert out == Decimal("0.00")


def test_rounds_half_up_to_cents() -> None:
    # 10000c=$100, +1% => $1/day; roas 2.5 margin 0.5 => net 0.25.
    # 1 * 0.25 * 30 = 7.50 exactly.
    out = estimate_scale_upside(
        current_daily_cents=10_000,
        roas=Decimal("2.5"),
        margin=Decimal("0.5"),
        increase_pct=1,
        horizon_days=30,
    )
    assert out == Decimal("7.50")
