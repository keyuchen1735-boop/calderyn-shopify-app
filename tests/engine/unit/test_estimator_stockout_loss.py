"""Unit tests for ``estimate_stockout_loss``.

Covers the four cases pinned in Plan 03 Task 6: standard happy path, zero
velocity, negative inputs clipped to zero, and the rounding edge case.
"""

from decimal import Decimal

from calderyn_engine.estimators.stockout_loss import estimate_stockout_loss


def test_standard_case() -> None:
    # 10 units/day velocity * 3 stockout days * $25 margin = $750.
    out = estimate_stockout_loss(
        daily_velocity_units=Decimal("10"),
        stockout_days=Decimal("3"),
        unit_margin=Decimal("25"),
    )
    assert out == Decimal("750.00")


def test_zero_velocity_is_zero() -> None:
    out = estimate_stockout_loss(
        daily_velocity_units=Decimal("0"),
        stockout_days=Decimal("5"),
        unit_margin=Decimal("30"),
    )
    assert out == Decimal("0.00")


def test_negative_inputs_clipped_to_zero() -> None:
    # Each negative input independently zeroes the result.
    assert estimate_stockout_loss(
        Decimal("-3"), Decimal("5"), Decimal("30")
    ) == Decimal("0.00")
    assert estimate_stockout_loss(
        Decimal("5"), Decimal("-1"), Decimal("30")
    ) == Decimal("0.00")
    assert estimate_stockout_loss(
        Decimal("5"), Decimal("3"), Decimal("-2")
    ) == Decimal("0.00")


def test_rounds_to_cents() -> None:
    # 3.333 * 2.5 * 7.77 = 64.738525 -> rounds half-up to $64.74.
    out = estimate_stockout_loss(
        daily_velocity_units=Decimal("3.333"),
        stockout_days=Decimal("2.5"),
        unit_margin=Decimal("7.77"),
    )
    assert out == Decimal("64.74")
