"""Estimator: ad spend that exceeded the gross profit it generated.

Formula: ``max(spend - gross_profit, 0)``.

When ``gross_profit`` is negative (e.g. heavy returns flipped a campaign's
contribution negative), the loss is still ``spend - gross_profit``, which
correctly increases the loss by the magnitude of the negative profit. We do
*not* clip ``gross_profit`` to zero, because that would silently hide a real
loss from the merchant.

We do clip the *result* at zero so that profitable campaigns never appear
as a negative "loss" — that would double-count their wins, since positive
ROAS is reported elsewhere.
"""

from decimal import ROUND_HALF_UP, Decimal

CENTS = Decimal("0.01")
ZERO = Decimal("0")


def estimate_below_breakeven_loss(
    spend: Decimal,
    gross_profit: Decimal,
) -> Decimal:
    """Return the dollars of ad spend not recovered by gross profit.

    Parameters
    ----------
    spend:
        Total ad spend over the measurement window. Clipped to ``>= 0``;
        negative spend is meaningless and would create a phantom loss.
    gross_profit:
        Attributed gross profit (revenue minus COGS) for the same window.
        May be negative — see module docstring.

    Returns
    -------
    Decimal
        ``max(spend - gross_profit, 0)`` rounded to cents.
    """

    spend_clean = max(spend, ZERO)
    loss = spend_clean - gross_profit
    return max(loss, ZERO).quantize(CENTS, rounding=ROUND_HALF_UP)
