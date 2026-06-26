"""Pure margin classification shared by the catalog margin detectors.

Operates on integer cents (the storage unit) and returns dollars as Decimal
only where a money figure is surfaced. No DB, no I/O — unit-tested directly.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Literal

MarginClass = Literal["below_cost", "thin", "ok"]


def classify_margin(price_cents: int, cost_cents: int, thin_pct: Decimal) -> MarginClass:
    """Classify a SKU by gross margin. ``thin_pct`` is a fraction (0.15 = 15%)."""
    if price_cents <= 0:
        return "ok"  # no price to judge against
    if cost_cents > price_cents:
        return "below_cost"
    margin = Decimal(price_cents - cost_cents) / Decimal(price_cents)
    return "thin" if margin < thin_pct else "ok"


def per_unit_loss_dollars(price_cents: int, cost_cents: int) -> Decimal:
    """Loss per sale in dollars when a SKU is priced below cost (>= 0)."""
    return (Decimal(cost_cents) - Decimal(price_cents)) / Decimal("100")
