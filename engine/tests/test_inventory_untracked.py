from calderyn_engine.detectors.inventory_untracked import untracked_result


def test_builds_low_severity_result():
    r = untracked_result("sku-9", "MUG-1", "Mug")
    assert r.detector_id == "inventory_untracked"
    assert r.severity == "low"
    assert r.entity_ref == {"sku_id": "sku-9", "sku": "MUG-1"}
    assert r.dollar_impact == 0
    assert r.evidence["sku_title"] == "Mug"
