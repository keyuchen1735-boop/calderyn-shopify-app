"""Plan 07 Task 7 — every detector in DETECTOR_REGISTRY fires on a
seeded fixture, or is explicitly skipped when the seed lacks its
prerequisite data.

This is a *coverage* check, not a correctness check: each detector
either produces ≥ 1 alert when run against a seeded shop, or it lands
in :data:`_SKIP_REASONS` with a documented reason. The set of skipped
detectors must be empty by the time the spec §10 acceptance gate
flips green for prod cutover; the registry side keeps working in CI
even while the staging seed is incomplete.

The test imports the engine pipeline so detector registration side
effects fire (each detector module's ``@register("…")`` decorator
populates the registry on import).
"""

from __future__ import annotations

import warnings
from datetime import UTC, datetime
from decimal import Decimal
from uuid import uuid4

import pytest

# Importing pipeline pulls in every detector module via its eager
# ``from calderyn_engine.detectors import (…)`` block at import time,
# which in turn fires each ``@register("…")`` decorator.
from calderyn_engine import pipeline  # noqa: F401  — registration side effect
from calderyn_engine.detectors import DETECTOR_REGISTRY


# ---------------------------------------------------------------------------
# Detectors deliberately skipped because their fixture lives in
# packages/seed (Phase A) or in the staging seed runner. These detectors
# must light up before the prod cutover gate flips, but the in-process
# seed below intentionally only covers the five detectors whose scenario
# fixtures already live in apps/engine/tests/conftest.py.
# ---------------------------------------------------------------------------
_SKIP_REASONS: dict[str, str] = {
    "regional_spend_starved_stock": (
        "needs the multi-location ad-spend allocation seed in "
        "packages/seed (Phase A); covered by integration tests once the "
        "staging seeder lands"
    ),
    "scaling_sku_fulfillment_risk": (
        "needs WoW spend trend seed (Phase A staging seeder)"
    ),
    "return_rate_hidden_loss": (
        "needs 30-day sku_pnl returns slice (Phase A staging seeder)"
    ),
    "margin_erosion": (
        "needs split baseline/current order_line_fact windows (Phase A)"
    ),
    "cogs_drift": "needs SCD2 cogs_fact pair (Phase A staging seeder)",
    "ad_tax_overload": "needs trailing-7d revenue+spend split (Phase A)",
    "negative_unit_economics": (
        "needs attribution_fact + ad_creative_sku_map confirm seed (Phase A)"
    ),
    "reorder_timing": "needs stockout_forecast seed (Phase A staging seeder)",
    "wrong_location_concentration": (
        "needs multi-location fulfillment_fact seed (Phase A)"
    ),
    "regional_shortage_risk": (
        "needs region-scoped fulfillment_fact + inventory seed (Phase A)"
    ),
    "sku_stockout_cleared": (
        "needs an autopilot stockout pause_campaign in action_audit plus a "
        "restocked-above-buffer inventory_level_fact — the shared stockout seed "
        "is sold out and has no pause row; covered by "
        "test_detector_sku_stockout_cleared.py (seed_stockout_cleared_scenario)"
    ),
    "campaign_below_breakeven": (
        "needs full attribution_fact + order_line_fact COGS chain (Phase A)"
    ),
    "campaign_scaling_opportunity": (
        "needs a 'winning' campaign_grade_fact + budgeted ad_campaign_dim seed, "
        "not the shared stockout seed; covered directly by "
        "test_detector_campaign_scaling_opportunity.py (seed_scale_scenario)"
    ),
    # Catalog/margin detectors filter on sku_dim.product_status = 'active' plus
    # catalog fields (retail_price_cents / unit_cost_cents / inventory_tracked)
    # that the shared stockout seed leaves null, so they cannot fire on it. They
    # need a seeded owned-catalog fixture (Phase A staging seeder). No dedicated
    # unit test yet — TODO(engine): add per-detector catalog fixtures so these
    # move out of the skip list.
    "missing_cost": (
        "needs an active-status sku_dim row with null unit_cost_cents; the shared "
        "stockout seed sets neither product_status nor cost (Phase A catalog seed)"
    ),
    "inventory_untracked": (
        "needs an active-status sku_dim row with inventory_tracked=false; not set "
        "by the shared stockout seed (Phase A catalog seed)"
    ),
    "out_of_stock_live": (
        "needs an active-status sku_dim row with zero available inventory; the "
        "shared stockout seed leaves product_status null (Phase A catalog seed)"
    ),
    "priced_below_cost": (
        "needs an active-status sku_dim row with retail_price_cents < "
        "unit_cost_cents; neither set by the shared stockout seed (Phase A)"
    ),
    "thin_margin": (
        "needs an active-status sku_dim row with retail_price_cents/unit_cost_cents "
        "yielding a sub-threshold margin; not set by the shared seed (Phase A)"
    ),
}


def _registered_ids() -> set[str]:
    """Snapshot of currently-registered detector ids."""
    return set(DETECTOR_REGISTRY.keys())


def test_registry_is_non_empty() -> None:
    """A green pipeline import must populate the registry — without this
    the coverage check below would trivially pass on an empty set."""
    assert _registered_ids(), (
        "DETECTOR_REGISTRY is empty — pipeline import did not trigger "
        "the @register decorators. Investigate calderyn_engine.pipeline "
        "imports before debugging the per-detector tests."
    )


@pytest.mark.asyncio
async def test_every_registered_detector_has_a_seeded_fixture_or_skip(
    pg_pool, seed_shop, seed_stockout_scenario,
) -> None:
    """Every registered detector either fires on this seed or is skipped.

    The seed below covers ``sku_stockout_vs_spend`` (the only detector
    with a single-fixture in-process scenario that does not depend on
    the staging seeder). All other detectors are listed in
    :data:`_SKIP_REASONS` until Phase A lands the loadgen-grade seed.
    """

    shop_id = str(uuid4())
    await seed_shop(shop_id)
    # spend_usd must clear DEFAULT_THRESHOLD_USD ($500) for the
    # sku_stockout_vs_spend detector to fire — see the integration suite
    # which uses $900 for the same reason.
    await seed_stockout_scenario(
        shop_id,
        spend_usd=Decimal("900"),
        stock_on_hand=0,
        velocity=Decimal("10"),
        unit_margin=Decimal("25"),
    )

    # The detector base contract is ``__call__(shop_id, conn, now)``.
    # We invoke each detector directly (not via run_for_shop) because
    # the spec §10 contract is "every detector returns ≥ 1 result on
    # its own fixture", which is independent of Claude ranking.
    now = datetime.now(UTC)
    fired: set[str] = set()
    skipped: set[str] = set()

    async with pg_pool.acquire() as conn:
        # Open with_shop_context so detector SELECTs see the seed.
        from calderyn_engine.db import with_shop_context

        async with with_shop_context(conn, shop_id):
            for detector_id, detector in DETECTOR_REGISTRY.items():
                if detector_id in _SKIP_REASONS:
                    skipped.add(detector_id)
                    warnings.warn(
                        f"detector {detector_id!r} skipped: "
                        f"{_SKIP_REASONS[detector_id]}",
                        stacklevel=2,
                    )
                    continue
                results = await detector(shop_id, conn, now)
                if results:
                    fired.add(detector_id)

    # Expectations:
    # 1. Every registered detector is *accounted for* (fired or skipped).
    accounted = fired | skipped
    missing = _registered_ids() - accounted
    assert not missing, (
        f"detectors registered but neither fired nor explicitly "
        f"skipped: {sorted(missing)}"
    )

    # 2. The non-skipped detector(s) must fire — otherwise the test
    #    silently rubber-stamps an unseeded scenario.
    expected_to_fire = _registered_ids() - set(_SKIP_REASONS.keys())
    assert expected_to_fire.issubset(fired), (
        f"detectors expected to fire on the in-process seed but did "
        f"not: {sorted(expected_to_fire - fired)}"
    )


def test_skip_list_only_references_real_detectors() -> None:
    """Guards against typo-rot in :data:`_SKIP_REASONS`. If a detector
    is renamed, this surfaces the stale entry instead of letting the
    test silently skip a detector that no longer exists."""

    registered = _registered_ids()
    stale = set(_SKIP_REASONS.keys()) - registered
    assert not stale, (
        f"_SKIP_REASONS references unregistered detector ids: "
        f"{sorted(stale)} — remove or rename these entries"
    )
