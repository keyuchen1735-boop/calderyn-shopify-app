"""Shared threshold resolver for detectors (Plan 05 slice #6).

Wraps :func:`calderyn_engine.thresholds.get_threshold` so a detector can
swap its static dollar constant for the learned, peer-informed value while
preserving its EXACT historical default when the moat is offline.

Why a wrapper instead of calling get_threshold directly: the shared
``_DETECTOR_THRESHOLDS`` registry pins a $500 default for every detector,
but four detectors historically gate at $200. Editing that shared registry
is out of scope for this slice (it is owned by the umbrella). So when
get_threshold returns the *registry default* (i.e. no override row and no
pepper produced a real signal), we substitute the caller's own historical
``fallback`` — guaranteeing zero behavior change offline. When an override
row exists, get_threshold returns a value != the registry default and we
pass it straight through.

``sku_stockout_vs_spend`` (the tracer) registers $500, which already equals
its module constant, so the substitution is a no-op for it; the wrapper is
still used so every detector shares one resolution path.
"""

from __future__ import annotations

from decimal import Decimal

import asyncpg

from calderyn_engine.thresholds import _DETECTOR_THRESHOLDS, get_threshold


async def resolve_threshold(
    conn: asyncpg.Connection,
    shop_id: str,
    detector_id: str,
    fallback: Decimal,
) -> Decimal:
    """Return the learned dollar threshold, or ``fallback`` when offline.

    ``fallback`` is the detector's own historical module constant. It is
    returned whenever ``get_threshold`` yields the registry default for
    ``detector_id`` (no override row / no pepper), so the detector's
    offline gate is unchanged even where the registry default differs from
    the detector's constant. ``get_threshold`` reads ``MOAT_PEPPER`` from
    the environment itself — no pepper is plumbed through here.
    """

    learned = await get_threshold(conn, shop_id, detector_id)
    _key, registry_default = _DETECTOR_THRESHOLDS.get(
        detector_id, ("min_impact_usd", Decimal("0"))
    )
    if learned == registry_default:
        return fallback
    return learned
