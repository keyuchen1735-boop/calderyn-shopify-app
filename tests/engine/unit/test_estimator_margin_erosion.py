"""Unit tests for ``estimate_margin_erosion_loss``."""

from decimal import Decimal

from calderyn_engine.estimators.margin_erosion_loss import (
    estimate_margin_erosion_loss,
)


def test_margin_erosion_standard() -> None:
    # baseline $10/unit, current $7/unit, 200 units sold -> $600 lost gp.
    out = estimate_margin_erosion_loss(
        units_sold=Decimal("200"),
        baseline_unit_margin=Decimal("10"),
        current_unit_margin=Decimal("7"),
    )
    assert out == Decimal("600.00")


def test_margin_improvement_returns_zero() -> None:
    # Current margin is *better* than baseline -> no loss recorded.
    out = estimate_margin_erosion_loss(
        units_sold=Decimal("100"),
        baseline_unit_margin=Decimal("5"),
        current_unit_margin=Decimal("7"),
    )
    assert out == Decimal("0.00")


def test_zero_units_returns_zero() -> None:
    out = estimate_margin_erosion_loss(
        units_sold=Decimal("0"),
        baseline_unit_margin=Decimal("10"),
        current_unit_margin=Decimal("3"),
    )
    assert out == Decimal("0.00")


def test_rounds_to_cents() -> None:
    # delta 0.333, units 7 -> 2.331 -> rounds to 2.33.
    out = estimate_margin_erosion_loss(
        units_sold=Decimal("7"),
        baseline_unit_margin=Decimal("10.000"),
        current_unit_margin=Decimal("9.667"),
    )
    assert out == Decimal("2.33")
