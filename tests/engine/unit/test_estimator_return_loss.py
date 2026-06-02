"""Unit tests for ``estimate_return_loss``."""

from decimal import Decimal

from calderyn_engine.estimators.return_loss import estimate_return_loss


def test_standard_return_loss() -> None:
    # 50 returned units * $15 unit cost = $750 in destroyed COGS.
    out = estimate_return_loss(
        returned_units=Decimal("50"),
        unit_cost=Decimal("15"),
    )
    assert out == Decimal("750.00")


def test_zero_returns_returns_zero() -> None:
    out = estimate_return_loss(
        returned_units=Decimal("0"),
        unit_cost=Decimal("10"),
    )
    assert out == Decimal("0.00")


def test_negative_inputs_clipped_to_zero() -> None:
    assert estimate_return_loss(
        returned_units=Decimal("-5"),
        unit_cost=Decimal("10"),
    ) == Decimal("0.00")
    assert estimate_return_loss(
        returned_units=Decimal("3"),
        unit_cost=Decimal("-1"),
    ) == Decimal("0.00")


def test_rounds_to_cents() -> None:
    # 3 * 1.005 = 3.015 -> rounds half-up to 3.02.
    out = estimate_return_loss(
        returned_units=Decimal("3"),
        unit_cost=Decimal("1.005"),
    )
    assert out == Decimal("3.02")
