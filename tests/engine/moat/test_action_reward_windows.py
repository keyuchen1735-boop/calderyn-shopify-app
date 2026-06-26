from calderyn_engine.moat.action_reward_windows import confirmation_window_days


def test_defensive_actions_confirm_in_three_days():
    assert confirmation_window_days("pause_campaign") == 3
    assert confirmation_window_days("reduce_campaign_budget") == 3


def test_growth_and_physical_actions_confirm_in_seven_days():
    for k in ("resume_campaign", "reallocate_budget", "discontinue_sku",
              "adjust_price", "reallocate_inventory"):
        assert confirmation_window_days(k) == 7


def test_unknown_kind_falls_back_to_fourteen():
    assert confirmation_window_days("create_po_draft") == 14
    assert confirmation_window_days("") == 14
