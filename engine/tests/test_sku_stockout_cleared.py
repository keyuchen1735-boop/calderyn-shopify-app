"""Pure-logic tests for the sku_stockout_cleared detector.

Mirrors the test_missing_cost pattern: the detector's SQL is exercised by the
DB integration suite; here we unit-test the pure buffer + eligibility + result
building so the fork-#2 "restocked above buffer" rule is locked without a DB.
"""

from __future__ import annotations

from decimal import Decimal

from calderyn_engine.detectors.sku_stockout_cleared import (
    BUFFER_DAYS,
    MIN_RESTOCK_UNITS,
    restock_buffer_units,
    stockout_cleared_result,
)

CAMPAIGN_ID = "22222222-2222-2222-2222-222222222222"
SKU_ID = "11111111-1111-1111-1111-111111111111"


def _result(**overrides):
    kwargs = dict(
        campaign_id=CAMPAIGN_ID,
        sku_id=SKU_ID,
        sku_code="TEST-1",
        sku_title="Test SKU",
        stock_units=Decimal("60"),
        velocity=Decimal("10"),
        fallback_velocity=Decimal("0"),
        unit_margin=Decimal("25"),
        prepause_spend_usd=Decimal("900"),
    )
    kwargs.update(overrides)
    return stockout_cleared_result(**kwargs)


# --- restock_buffer_units -------------------------------------------------


def test_buffer_is_velocity_times_buffer_days():
    # 10 units/day * 3 days = 30, well above the floor.
    assert restock_buffer_units(Decimal("10")) == 30
    assert BUFFER_DAYS == Decimal("3")


def test_buffer_rounds_up_fractional_velocity():
    # 2.5 * 3 = 7.5 -> ceil -> 8.
    assert restock_buffer_units(Decimal("2.5")) == 8


def test_buffer_floors_at_min_units_for_slow_movers():
    # 1 * 3 = 3, below the floor -> MIN_RESTOCK_UNITS.
    assert restock_buffer_units(Decimal("1")) == MIN_RESTOCK_UNITS
    assert MIN_RESTOCK_UNITS == 5


def test_buffer_uses_fallback_when_current_velocity_is_zero():
    # Ads were paused, so live velocity can read 0; fall back to pause-time
    # velocity so the buffer reflects real demand once ads resume.
    assert restock_buffer_units(Decimal("0"), fallback_velocity=Decimal("10")) == 30


def test_buffer_floors_when_no_velocity_signal_at_all():
    assert restock_buffer_units(Decimal("0"), fallback_velocity=Decimal("0")) == MIN_RESTOCK_UNITS


# --- stockout_cleared_result ---------------------------------------------


def test_no_result_when_stock_below_buffer():
    # velocity 10 -> buffer 30; only 29 units back in stock -> not enough.
    assert _result(stock_units=Decimal("29")) is None


def test_result_when_stock_at_or_above_buffer():
    r = _result(stock_units=Decimal("30"))
    assert r is not None
    assert r.detector_id == "sku_stockout_cleared"
    assert r.severity == "medium"


def test_entity_ref_carries_campaign_and_sku():
    # campaign_id is REQUIRED so v_autopilot_candidates can resolve the campaign.
    r = _result()
    assert r.entity_ref["campaign_id"] == CAMPAIGN_ID
    assert r.entity_ref["sku_id"] == SKU_ID
    assert r.entity_ref["sku"] == "TEST-1"


def test_evidence_also_carries_campaign_id_for_merchant_approve():
    # The merchant-approve path (alert action handler) resolves the campaign from
    # alert.evidence.campaign_id, so the detector must mirror entity_ref's
    # campaign_id into evidence (EvidencePanel suppresses it from display).
    r = _result()
    assert r.evidence["campaign_id"] == CAMPAIGN_ID


def test_evidence_reports_stock_buffer_and_prepause_spend():
    r = _result(stock_units=Decimal("60"), velocity=Decimal("10"))
    assert r.evidence["stock_units"] == "60"
    assert r.evidence["buffer_units"] == "30"
    assert r.evidence["prepause_spend_7d_usd"] == "900"
    assert r.evidence["velocity_units_per_day"] == "10"
    assert r.evidence["sku_title"] == "Test SKU"


def test_dollar_impact_is_recovered_profit_over_buffer_horizon():
    # velocity 10 * BUFFER_DAYS 3 * unit_margin 25 = 750.
    r = _result(velocity=Decimal("10"), unit_margin=Decimal("25"))
    assert r.dollar_impact == Decimal("750.00")


def test_dollar_impact_falls_back_to_prepause_spend_without_margin():
    # No usable margin -> fall back to the at-stake pre-pause spend.
    r = _result(unit_margin=Decimal("0"), prepause_spend_usd=Decimal("900"))
    assert r.dollar_impact == Decimal("900.00")
