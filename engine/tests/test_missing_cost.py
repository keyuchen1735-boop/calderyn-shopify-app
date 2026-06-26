from calderyn_engine.detectors.missing_cost import missing_cost_result


def test_summarizes_missing_cost_count_shop_level():
    r = missing_cost_result(12, 26)
    assert r is not None
    assert r.detector_id == "missing_cost"
    assert r.severity == "low"
    assert r.entity_ref == {"scope": "shop"}
    assert r.dollar_impact == 0
    assert r.evidence == {"count": "12", "total": "26"}


def test_no_alert_when_all_costs_present():
    assert missing_cost_result(0, 26) is None
