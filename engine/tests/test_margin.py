from decimal import Decimal

from calderyn_engine.detectors._margin import classify_margin, per_unit_loss_dollars

THIN = Decimal("0.15")


def test_below_cost_when_cost_exceeds_price():
    assert classify_margin(2000, 2500, THIN) == "below_cost"


def test_thin_when_margin_under_threshold():
    # price 100.00, cost 90.00 -> 10% margin < 15%
    assert classify_margin(10000, 9000, THIN) == "thin"


def test_ok_when_margin_healthy():
    assert classify_margin(10000, 5000, THIN) == "ok"


def test_ok_when_no_price():
    assert classify_margin(0, 5000, THIN) == "ok"


def test_per_unit_loss_is_positive_dollars():
    assert per_unit_loss_dollars(2000, 2500) == Decimal("5.00")
