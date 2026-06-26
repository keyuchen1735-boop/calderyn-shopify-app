"""Pure per-action-kind outcome confirmation windows (design 2026-06-26 §4.2).

How many days after an autopilot action we wait before its measured outcome can
be counted toward graduation. Matched to how fast each action's dollar signal
actually appears: defensive loss-stops show within days; growth/demand and
physical moves need about a week of orders. No I/O.
"""
from __future__ import annotations

# Defensive: the bleed stops the instant spend stops; 3 days confirms it held.
_FAST_DAYS = 3
# Growth / demand-dependent / physical: a week of conversions to read the result.
_SLOW_DAYS = 7
# Unknown / not-yet-scored kinds: the old conservative window.
_DEFAULT_DAYS = 14

_WINDOWS: dict[str, int] = {
    "pause_campaign": _FAST_DAYS,
    "reduce_campaign_budget": _FAST_DAYS,
    "resume_campaign": _SLOW_DAYS,
    "reallocate_budget": _SLOW_DAYS,
    "discontinue_sku": _SLOW_DAYS,
    "adjust_price": _SLOW_DAYS,
    "reallocate_inventory": _SLOW_DAYS,
}


def confirmation_window_days(action_kind: str) -> int:
    """Days to wait before ``action_kind``'s outcome is countable."""
    return _WINDOWS.get(action_kind, _DEFAULT_DAYS)
