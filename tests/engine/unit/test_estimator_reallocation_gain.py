"""Unit tests for ``estimate_reallocation_gain``."""

from decimal import Decimal

from calderyn_engine.estimators.reallocation_gain import (
    estimate_reallocation_gain,
)


def test_positive_gain() -> None:
    # 40 units shortfall * $12 margin = $480, less $80 transfer = $400.
    out = estimate_reallocation_gain(
        demand_shortfall_units=Decimal("40"),
        unit_margin=Decimal("12"),
        transfer_cost=Decimal("80"),
    )
    assert out == Decimal("400.00")


def test_transfer_cost_wipes_out_gain() -> None:
    # 1 unit * $10 = $10 of margin, $50 transfer -> net negative -> floor 0.
    out = estimate_reallocation_gain(
        demand_shortfall_units=Decimal("1"),
        unit_margin=Decimal("10"),
        transfer_cost=Decimal("50"),
    )
    assert out == Decimal("0.00")


def test_zero_shortfall_returns_zero() -> None:
    out = estimate_reallocation_gain(
        demand_shortfall_units=Decimal("0"),
        unit_margin=Decimal("25"),
        transfer_cost=Decimal("5"),
    )
    assert out == Decimal("0.00")


def test_rounds_to_cents() -> None:
    # 7 * 3.333 = 23.331, less 1.005 transfer = 22.326 -> 22.33.
    out = estimate_reallocation_gain(
        demand_shortfall_units=Decimal("7"),
        unit_margin=Decimal("3.333"),
        transfer_cost=Decimal("1.005"),
    )
    assert out == Decimal("22.33")
