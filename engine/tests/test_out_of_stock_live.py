from calderyn_engine.detectors.out_of_stock_live import out_of_stock_result


def test_builds_high_severity_result_with_sku_ref():
    r = out_of_stock_result("sku-1", "TEE-1", "Tee — S", 0)
    assert r.detector_id == "out_of_stock_live"
    assert r.severity == "high"
    assert r.entity_ref == {"sku_id": "sku-1", "sku": "TEE-1"}
    assert r.dollar_impact == 0
    assert r.evidence["available"] == "0"
