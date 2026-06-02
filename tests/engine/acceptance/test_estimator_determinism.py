"""Plan 07 Task 8 — estimator determinism.

For each pure-function estimator in
:mod:`calderyn_engine.estimators`, we pin a fixed input vector,
compute it 100 times, and assert the Decimal output is byte-identical
every time (same string repr, same exponent, same value). Pure
functions in Decimal arithmetic should never drift, so any failure
here points at a future change that introduced wall-clock dependence,
shared mutable state, or an unstable rounding mode.

This test is a load-bearing piece of the spec §10 acceptance matrix —
"estimators deterministic to the cent" — and is run on every push to
master via the acceptance-gate workflow.
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from calderyn_engine.estimators import (
    estimate_below_breakeven_loss,
    estimate_margin_erosion_loss,
    estimate_reallocation_gain,
    estimate_return_loss,
    estimate_stockout_loss,
)


# Fixed input vectors per estimator. Each tuple is (kwargs, expected).
# The expected value is the documented contract: changing any input
# without updating expected here is a deliberate behaviour change and
# should be debated before being merged.
_ITERATIONS = 100


def _run(fn, kwargs: dict[str, Decimal], expected: Decimal) -> None:
    """Invoke ``fn`` ``_ITERATIONS`` times; every result must equal
    ``expected`` and have the same Decimal tuple representation
    (sign / digits / exponent). Equality alone is not sufficient —
    ``Decimal('750')`` == ``Decimal('750.00')`` but their reprs
    differ, which would silently break wire-format determinism."""

    first = fn(**kwargs)
    assert first == expected, (
        f"{fn.__name__}({kwargs!r}) returned {first!r}, expected "
        f"{expected!r}"
    )
    canonical = first.as_tuple()
    for i in range(_ITERATIONS):
        result = fn(**kwargs)
        assert result == expected, (
            f"iteration {i}: {fn.__name__} drifted from {expected!r} "
            f"to {result!r}"
        )
        assert result.as_tuple() == canonical, (
            f"iteration {i}: {fn.__name__} representation drifted "
            f"({result.as_tuple()!r} vs {canonical!r}) — Decimal "
            f"value-equal but byte-different output is a determinism "
            f"regression"
        )


def test_stockout_loss_deterministic() -> None:
    _run(
        estimate_stockout_loss,
        kwargs={
            "daily_velocity_units": Decimal("10"),
            "stockout_days": Decimal("3"),
            "unit_margin": Decimal("25"),
        },
        expected=Decimal("750.00"),
    )


def test_below_breakeven_loss_deterministic() -> None:
    # spend=1500, gross_profit=600 → 1500 - 600 = 900.00.
    _run(
        estimate_below_breakeven_loss,
        kwargs={"spend": Decimal("1500"), "gross_profit": Decimal("600")},
        expected=Decimal("900.00"),
    )


def test_margin_erosion_loss_deterministic() -> None:
    # baseline=0.30, current=0.20, units=100 → 0.10 * 100 = 10.00.
    _run(
        estimate_margin_erosion_loss,
        kwargs={
            "units_sold": Decimal("100"),
            "baseline_unit_margin": Decimal("0.30"),
            "current_unit_margin": Decimal("0.20"),
        },
        expected=Decimal("10.00"),
    )


def test_margin_erosion_loss_clips_negative_delta() -> None:
    # current > baseline ⇒ no loss, regardless of how often we recompute.
    _run(
        estimate_margin_erosion_loss,
        kwargs={
            "units_sold": Decimal("100"),
            "baseline_unit_margin": Decimal("0.30"),
            "current_unit_margin": Decimal("0.35"),
        },
        expected=Decimal("0.00"),
    )


def test_return_loss_deterministic() -> None:
    # 5 * 20 = 100.00.
    _run(
        estimate_return_loss,
        kwargs={
            "returned_units": Decimal("5"),
            "unit_cost": Decimal("20"),
        },
        expected=Decimal("100.00"),
    )


def test_reallocation_gain_deterministic() -> None:
    # 10 units * $15 margin = 150 gross; minus $30 transfer = $120 net.
    _run(
        estimate_reallocation_gain,
        kwargs={
            "demand_shortfall_units": Decimal("10"),
            "unit_margin": Decimal("15"),
            "transfer_cost": Decimal("30"),
        },
        expected=Decimal("120.00"),
    )


def test_reallocation_gain_clips_when_transfer_dominates() -> None:
    # Transfer cost exceeds margin unlocked ⇒ no positive gain.
    _run(
        estimate_reallocation_gain,
        kwargs={
            "demand_shortfall_units": Decimal("2"),
            "unit_margin": Decimal("5"),
            "transfer_cost": Decimal("100"),
        },
        expected=Decimal("0.00"),
    )


@pytest.mark.parametrize(
    "fn,kwargs",
    [
        (
            estimate_stockout_loss,
            {
                "daily_velocity_units": Decimal("3.333"),
                "stockout_days": Decimal("2.5"),
                "unit_margin": Decimal("7.77"),
            },
        ),
        (
            estimate_below_breakeven_loss,
            {"spend": Decimal("123.456"), "gross_profit": Decimal("100.111")},
        ),
        (
            estimate_margin_erosion_loss,
            {
                "units_sold": Decimal("17"),
                "baseline_unit_margin": Decimal("0.123"),
                "current_unit_margin": Decimal("0.077"),
            },
        ),
    ],
)
def test_rounding_edges_remain_byte_identical(fn, kwargs) -> None:
    """Estimators that hit the rounding seam — three-digit precision
    inputs that round half-up — must still return the same canonical
    tuple every time."""

    first = fn(**kwargs)
    canonical = first.as_tuple()
    for _ in range(_ITERATIONS):
        again = fn(**kwargs)
        assert again == first
        assert again.as_tuple() == canonical
