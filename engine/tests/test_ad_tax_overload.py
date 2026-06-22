"""Unit tests for the ad_tax_overload worst-offender attribution.

The detector's *trigger* is shop-level (ad spend / revenue >= 40%), but the alert
must name the single SKU whose ads drive the most of that spend so the dashboard
remediation (move budget / cut ads) has a concrete target. That selection is a
pure function — tested here without a DB.
"""
from calderyn_engine.detectors.ad_tax_overload import select_ad_tax_offender


def _row(sku_id, spend_cents):
    return {
        "sku_id": sku_id,
        "sku": f"SKU-{sku_id.upper()}",
        "title": f"Product {sku_id.upper()}",
        "attributed_spend_cents": spend_cents,
    }


def test_picks_the_sku_with_the_most_attributed_ad_spend():
    rows = [_row("a", 120_000), _row("b", 350_000), _row("c", 90_000)]
    offender = select_ad_tax_offender(rows)
    assert offender is not None
    assert offender["sku_id"] == "b"


def test_ignores_skus_below_the_min_spend_floor():
    # The worst offender must still clear a floor; otherwise the alert stays
    # shop-level rather than blaming a SKU with trivial attributed spend.
    rows = [_row("a", 10_000), _row("b", 25_000)]
    assert select_ad_tax_offender(rows, min_spend_cents=50_000) is None


def test_no_attributable_skus_falls_back_to_shop_level():
    # No per-SKU attribution at all -> None, so detect() keeps the shop-level
    # entity_ref it has today (never a dead remediation target).
    assert select_ad_tax_offender([]) is None
