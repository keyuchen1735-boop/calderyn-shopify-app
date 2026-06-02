"""Estimator: net gain from rebalancing inventory between locations.

Formula: ``max(0, demand_shortfall_units * unit_margin - transfer_cost)``.

The ``max(0, ...)`` guards against a transfer that would cost more than the
margin it unlocks — in that case the right action is *not* to reallocate, so
the alert is suppressed by reporting a zero gain.
"""

from decimal import ROUND_HALF_UP, Decimal

CENTS = Decimal("0.01")
ZERO = Decimal("0")


def estimate_reallocation_gain(
    demand_shortfall_units: Decimal,
    unit_margin: Decimal,
    transfer_cost: Decimal,
) -> Decimal:
    """Return the net dollars unlocked by transferring stock between locations.

    Parameters
    ----------
    demand_shortfall_units:
        Units of unmet demand at the destination location during the
        measurement window. Clipped to ``>= 0``.
    unit_margin:
        Gross profit per unit if the demand were fulfilled. Clipped to ``>= 0``.
    transfer_cost:
        All-in cost of moving the inventory (freight, labour, restocking).
        May be any value — a negative transfer cost (e.g. a vendor credit)
        legitimately increases the gain.

    Returns
    -------
    Decimal
        ``max(0, demand_shortfall * unit_margin - transfer_cost)``
        rounded to cents.
    """

    shortfall = max(demand_shortfall_units, ZERO)
    margin = max(unit_margin, ZERO)
    gross = shortfall * margin
    net = gross - transfer_cost
    return max(net, ZERO).quantize(CENTS, rounding=ROUND_HALF_UP)
