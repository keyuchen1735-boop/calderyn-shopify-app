"""Unit tests for ``estimate_below_breakeven_loss``.

The signature is ``(spend, gross_profit) -> Decimal``: the caller is
responsible for pre-computing gross profit (revenue - COGS) and any
attribution adjustments before handing it to the estimator.
"""

from decimal import Decimal

from calderyn_engine.estimators.below_breakeven_loss import (
    estimate_below_breakeven_loss,
)


def test_standard_loss_case() -> None:
    # spend $1000, gp $300 -> uncovered ad spend = $700.
    out = estimate_below_breakeven_loss(
        spend=Decimal("1000"),
        gross_profit=Decimal("300"),
    )
    assert out == Decimal("700.00")


def test_profitable_returns_zero() -> None:
    # spend $500, gp $700 -> profitable; estimator does not return a
    # negative loss because that would double-count the ROAS win.
    out = estimate_below_breakeven_loss(
        spend=Decimal("500"),
        gross_profit=Decimal("700"),
    )
    assert out == Decimal("0.00")


def test_negative_gross_profit_increases_loss() -> None:
    # Returns flipped attributed gp negative; the loss should be
    # spend - (-100) = spend + 100.
    out = estimate_below_breakeven_loss(
        spend=Decimal("400"),
        gross_profit=Decimal("-100"),
    )
    assert out == Decimal("500.00")


def test_breakeven_returns_zero() -> None:
    # spend == gp exactly -> loss is zero, not a negative epsilon.
    out = estimate_below_breakeven_loss(
        spend=Decimal("250"),
        gross_profit=Decimal("250"),
    )
    assert out == Decimal("0.00")


def test_rounds_to_cents() -> None:
    # 100.005 - 33.333 = 66.672 -> rounds half-up to 66.67.
    out = estimate_below_breakeven_loss(
        spend=Decimal("100.005"),
        gross_profit=Decimal("33.333"),
    )
    assert out == Decimal("66.67")
