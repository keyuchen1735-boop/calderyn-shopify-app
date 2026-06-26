from calderyn_engine.detectors.thin_margin import thin_margin_result


def test_builds_medium_severity_with_margin_pct():
    r = thin_margin_result("sku-2", "HAT-1", "Hat", 10000, 9000)
    assert r.detector_id == "thin_margin"
    assert r.severity == "medium"
    assert r.dollar_impact == 0
    assert r.evidence["margin_pct"] == "10"
