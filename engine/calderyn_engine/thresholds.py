"""Per-shop, per-detector threshold lookup.

Plan 03 Task 25. Each of the 12 detectors ships a module-level
``DEFAULT_THRESHOLD_USD = Decimal("500")`` (or analogous). This module
adds an opt-in DB-driven override layer: ``get_threshold(conn, shop_id,
detector_id)`` reads from the ``alert_thresholds`` table and returns the
override as :class:`Decimal`, falling back to the per-detector module's
constant when no row exists.

``alert_thresholds.threshold_json`` is shaped as a JSON object, e.g.
``{"min_spend_usd": 500}``. Each detector has its own canonical key
(``min_spend_usd`` for spend-driven detectors, ``min_loss_usd`` for
break-even, ``min_impact_usd`` for the rest, etc.). We register the
canonical key alongside the default constant so a future migration that
adds a new detector knows where to look.

Threading this call into all 12 detectors is invasive; per Plan 03
guidance we ship the helper here and leave the existing detectors using
their module-level default. A follow-up task can switch each detector
to call :func:`get_threshold` once the contract is stable.

Plan 05 Task 14 — moat.detection_models layer. The threshold trainer
(workers/moat-trainer) writes per-pseudonym posteriors and rescaled
threshold_json into ``moat.detection_models``. Lookup order is now:

    1. ``moat.detection_models`` row keyed by (detector_id,
       shop_id_pseudonym). The pseudonym is computed from
       ``shop_id`` and the active pepper (read from ``MOAT_PEPPER``
       env var by default; tests inject explicitly). When missing or
       the pepper is unset, fall through.
    2. ``alert_thresholds`` row keyed by (shop_id, detector_id).
    3. The detector's module-level default in :data:`_DETECTOR_THRESHOLDS`.
"""

from __future__ import annotations

import json
import os
from decimal import Decimal
from typing import Any

import asyncpg

from .moat.pseudonym import pseudonym_for

# Canonical (key, default) per detector. The default value is duplicated
# from the detector module's DEFAULT_THRESHOLD_USD for the spend-driven
# detectors so tests don't need to import every detector module to
# resolve a default. When a detector's primary threshold isn't a single
# dollar amount (e.g. ratios, days, percentages), we still pick one
# numeric anchor that the detector treats as its dollar gate.
_DETECTOR_THRESHOLDS: dict[str, tuple[str, Decimal]] = {
    "sku_stockout_vs_spend": ("min_spend_usd", Decimal("500")),
    "campaign_below_breakeven": ("min_loss_usd", Decimal("500")),
    "regional_spend_starved_stock": ("min_spend_usd", Decimal("500")),
    "scaling_sku_fulfillment_risk": ("min_impact_usd", Decimal("500")),
    "return_rate_hidden_loss": ("min_impact_usd", Decimal("500")),
    "margin_erosion": ("min_impact_usd", Decimal("500")),
    "cogs_drift": ("min_impact_usd", Decimal("500")),
    "ad_tax_overload": ("min_impact_usd", Decimal("500")),
    "negative_unit_economics": ("min_impact_usd", Decimal("500")),
    "reorder_timing": ("min_impact_usd", Decimal("500")),
    "wrong_location_concentration": ("min_impact_usd", Decimal("500")),
    "regional_shortage_risk": ("min_impact_usd", Decimal("500")),
}


async def get_threshold(
    conn: asyncpg.Connection,
    shop_id: str,
    detector_id: str,
    *,
    pepper: str | None = None,
) -> Decimal:
    """Return the override Decimal threshold for a (shop, detector) pair.

    Lookup order:

    1. ``moat.detection_models`` row keyed by ``(detector_id,
       shop_id_pseudonym)`` (Plan 05 Task 14). When ``pepper`` is
       provided (or :envvar:`MOAT_PEPPER` is set in the environment),
       compute the pseudonym and try this layer first. The trainer
       writes ``threshold_json`` here on every nightly run; a present
       row is the freshest signal.
    2. ``alert_thresholds`` row keyed by ``(shop_id, detector_id)``.
       If found, the canonical key for the detector is read out of
       the JSON payload and coerced to ``Decimal``.
    3. The detector's module-level default (registered in
       :data:`_DETECTOR_THRESHOLDS`).
    4. ``Decimal("0")`` as a last-resort floor — only reached for an
       unknown ``detector_id`` not present in the registry, which is
       itself a programming error.

    The DB row's JSON is parsed defensively: asyncpg returns ``jsonb``
    either as a string or as a Python dict depending on codec setup, and
    we accept either.
    """

    canonical_key, default = _DETECTOR_THRESHOLDS.get(
        detector_id, ("min_impact_usd", Decimal("0"))
    )

    # Plan 05 Task 14 — moat.detection_models layer. Best-effort: a
    # missing schema (older migration state) or a missing pepper
    # silently falls through to the legacy path. We do NOT raise here
    # because the engine is designed to keep functioning even when
    # the moat layer is offline.
    active_pepper = pepper if pepper is not None else os.environ.get("MOAT_PEPPER")
    if active_pepper:
        try:
            pid = pseudonym_for(shop_id, active_pepper)
            moat_row = await conn.fetchrow(
                """
                SELECT threshold_json
                FROM moat.detection_models
                WHERE detector_id = $1 AND shop_id_pseudonym = $2
                """,
                detector_id,
                pid,
            )
        except Exception:  # noqa: BLE001
            moat_row = None
        if moat_row is not None:
            moat_payload = _coerce_jsonb(moat_row["threshold_json"])
            if isinstance(moat_payload, dict):
                raw = moat_payload.get(canonical_key)
                if raw is not None:
                    return _coerce_decimal(raw, default=default)

    row = await conn.fetchrow(
        """
        SELECT threshold_json
        FROM alert_thresholds
        WHERE shop_id = $1::uuid AND detector_id = $2
        """,
        shop_id,
        detector_id,
    )
    if row is None:
        return default

    payload = _coerce_jsonb(row["threshold_json"])
    if not isinstance(payload, dict):
        return default

    raw = payload.get(canonical_key)
    if raw is None:
        # The override row exists but doesn't carry our canonical key —
        # treat as "no override". A later helper can surface a warning
        # in observability if this turns out to happen often.
        return default

    return _coerce_decimal(raw, default=default)


def _coerce_jsonb(value: Any) -> Any:
    """Parse asyncpg-returned jsonb that might be str or dict already."""
    if isinstance(value, str):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return None
    return value


def _coerce_decimal(value: Any, *, default: Decimal) -> Decimal:
    """Convert a JSON scalar to Decimal; fall back to ``default`` on error."""
    if isinstance(value, Decimal):
        return value
    if isinstance(value, (int, float, str)):
        try:
            return Decimal(str(value))
        except (ValueError, ArithmeticError):
            return default
    return default
