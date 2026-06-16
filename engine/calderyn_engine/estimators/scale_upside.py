"""Estimator: projected incremental contribution margin from scaling a winner.

We raise a winning campaign's daily budget by ``increase_pct`` percent and
assume its ROAS holds at the current level over ``horizon_days``. Per added
dollar of spend the incremental contribution margin is ``roas * margin - 1``
(revenue per dollar * margin, minus the dollar spent). For a *winning*
campaign this is >= 0.2 because winning means ``roas >= 1.2 / margin``.

This is an optimistic "if performance holds" projection (real scaling sees
diminishing returns); it exists to rank and explain opportunities, not to
promise an outcome. Returns DOLLARS, matching ``alerts.dollar_impact``.
"""

from decimal import ROUND_HALF_UP, Decimal

CENTS = Decimal("0.01")
ZERO = Decimal("0")
ONE = Decimal("1")
HUNDRED = Decimal("100")


def estimate_scale_upside(
    current_daily_cents: int,
    roas: Decimal,
    margin: Decimal,
    increase_pct: int,
    horizon_days: int = 30,
) -> Decimal:
    """Return projected incremental margin (dollars) over the horizon.

    Parameters
    ----------
    current_daily_cents:
        The campaign's current daily budget, in cents.
    roas:
        Current return on ad spend (revenue / spend).
    margin:
        Contribution margin (0 < margin < 1) used to grade the campaign.
    increase_pct:
        Percentage to raise the daily budget by (e.g. 20).
    horizon_days:
        Projection window. Defaults to 30 to match the "+$X/mo" framing.

    Returns
    -------
    Decimal
        ``max(incremental_daily_dollars * (roas*margin - 1) * horizon, 0)``,
        rounded half-up to cents.
    """
    incremental_daily_dollars = (
        Decimal(current_daily_cents) / HUNDRED
    ) * (Decimal(increase_pct) / HUNDRED)
    net_per_dollar = roas * margin - ONE
    upside = incremental_daily_dollars * net_per_dollar * Decimal(horizon_days)
    return max(upside, ZERO).quantize(CENTS, rounding=ROUND_HALF_UP)
