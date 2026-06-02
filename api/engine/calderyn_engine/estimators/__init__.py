"""Pure-function dollar estimators.

Every estimator in this package:

* Takes ``Decimal`` inputs and returns ``Decimal`` rounded to 2dp via
  ``quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)``.
* Performs no I/O — no database, no network, no Claude calls.
* Clips negative or otherwise non-sensical inputs to a safe lower bound
  (typically zero) instead of propagating sign errors into alert dollars.

These functions are imported by the detectors layer and by the deterministic
fallback templates; both code paths must agree on the dollar math, so the
implementations live here as a single source of truth.
"""

from calderyn_engine.estimators.below_breakeven_loss import (
    estimate_below_breakeven_loss,
)
from calderyn_engine.estimators.margin_erosion_loss import (
    estimate_margin_erosion_loss,
)
from calderyn_engine.estimators.reallocation_gain import (
    estimate_reallocation_gain,
)
from calderyn_engine.estimators.return_loss import estimate_return_loss
from calderyn_engine.estimators.stockout_loss import estimate_stockout_loss

__all__ = [
    "estimate_below_breakeven_loss",
    "estimate_margin_erosion_loss",
    "estimate_reallocation_gain",
    "estimate_return_loss",
    "estimate_stockout_loss",
]
