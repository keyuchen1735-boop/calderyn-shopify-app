"""Estimator: gross profit lost because per-unit margin compressed.

Formula: ``(baseline_unit_margin - current_unit_margin) * units_sold`` when
the current margin is below baseline; ``0`` otherwise.

A *positive* margin delta (current improving over baseline) is **not**
reported as a negative loss — that would double-count the win against the
baseline alert that already records margin improvements separately.
"""

from decimal import ROUND_HALF_UP, Decimal

CENTS = Decimal("0.01")
ZERO = Decimal("0")


def estimate_margin_erosion_loss(
    units_sold: Decimal,
    baseline_unit_margin: Decimal,
    current_unit_margin: Decimal,
) -> Decimal:
    """Return the dollars of gross profit lost to margin compression.

    Parameters
    ----------
    units_sold:
        Units sold during the measurement window. Clipped to ``>= 0``;
        zero or negative units short-circuit to ``0.00``.
    baseline_unit_margin:
        Per-unit gross profit during the baseline window (e.g. trailing
        90-day median).
    current_unit_margin:
        Per-unit gross profit during the current window.

    Returns
    -------
    Decimal
        ``(baseline - current) * units`` if margin contracted, else
        ``Decimal("0.00")``. Rounded to cents.
    """

    units = max(units_sold, ZERO)
    if units == ZERO:
        return Decimal("0.00")
    delta = baseline_unit_margin - current_unit_margin
    if delta <= ZERO:
        return Decimal("0.00")
    return (delta * units).quantize(CENTS, rounding=ROUND_HALF_UP)
