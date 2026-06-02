"""Estimator: cost of goods written off via returns.

Formula: ``returned_units * unit_cost``.

This represents the COGS dollars merchants lose when a return cannot be
restocked (damaged, opened, shipped from a different location and not worth
shipping back, etc.). Processing fees and refund administrative costs are
intentionally **not** rolled in here; they live in a separate operations
estimator so each cost can be attributed to its own action.
"""

from decimal import ROUND_HALF_UP, Decimal

CENTS = Decimal("0.01")
ZERO = Decimal("0")


def estimate_return_loss(
    returned_units: Decimal,
    unit_cost: Decimal,
) -> Decimal:
    """Return the COGS dollars destroyed by returns.

    Parameters
    ----------
    returned_units:
        Units returned in the measurement window. Clipped to ``>= 0``.
    unit_cost:
        COGS per unit. Clipped to ``>= 0`` — a negative COGS would imply
        the merchant is paid to receive the goods, which we treat as a
        data-quality issue and zero out.

    Returns
    -------
    Decimal
        ``returned_units * unit_cost`` rounded to cents.
    """

    units = max(returned_units, ZERO)
    cost = max(unit_cost, ZERO)
    return (units * cost).quantize(CENTS, rounding=ROUND_HALF_UP)
