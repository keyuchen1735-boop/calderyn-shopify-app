"""Estimator: lost gross profit while a SKU was out of stock.

Formula: ``daily_velocity_units * stockout_days * unit_margin``.

Negative inputs are clipped to zero — a negative velocity, negative stockout
window, or negative margin all mean "no realised loss" rather than a credit.
"""

from decimal import ROUND_HALF_UP, Decimal

CENTS = Decimal("0.01")
ZERO = Decimal("0")


def estimate_stockout_loss(
    daily_velocity_units: Decimal,
    stockout_days: Decimal,
    unit_margin: Decimal,
) -> Decimal:
    """Return the dollars of gross profit lost during a stockout window.

    Parameters
    ----------
    daily_velocity_units:
        Average units sold per day before the stockout. Clipped to ``>= 0``.
    stockout_days:
        Length of the stockout window in days. Clipped to ``>= 0``.
    unit_margin:
        Gross profit per unit (revenue per unit minus COGS per unit). Clipped
        to ``>= 0`` so a unit being sold below cost does not turn a stockout
        into a "savings" line item.

    Returns
    -------
    Decimal
        Estimated lost gross profit, rounded to 2 decimal places using
        banker-free ``ROUND_HALF_UP``.
    """

    velocity = max(daily_velocity_units, ZERO)
    days = max(stockout_days, ZERO)
    margin = max(unit_margin, ZERO)
    return (velocity * days * margin).quantize(CENTS, rounding=ROUND_HALF_UP)
