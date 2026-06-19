from decimal import Decimal
from calderyn_engine.moat.action_rewards import compute_action_reward, UNDO_PENALTY

def test_pause_rewards_loss_averted_when_was_below_breakeven():
    r = compute_action_reward("pause_campaign",
                              pre_roas=Decimal("0.5"), post_roas=Decimal("0"),
                              pre_profit_cents=-30000, post_profit_cents=0,
                              break_even_roas=Decimal("1.5"), undone=False)
    assert r == Decimal("300")  # loss averted, in dollars

def test_increase_rewards_profit_delta_only_above_breakeven():
    r = compute_action_reward("increase_campaign_budget",
                              pre_roas=Decimal("2.0"), post_roas=Decimal("2.1"),
                              pre_profit_cents=10000, post_profit_cents=25000,
                              break_even_roas=Decimal("1.5"), undone=False)
    assert r == Decimal("150")  # +$150 profit, ROAS stayed above BE

def test_increase_into_diminishing_returns_is_penalised():
    r = compute_action_reward("increase_campaign_budget",
                              pre_roas=Decimal("2.0"), post_roas=Decimal("1.2"),
                              pre_profit_cents=10000, post_profit_cents=4000,
                              break_even_roas=Decimal("1.5"), undone=False)
    assert r < 0  # ROAS fell below BE after scaling

def test_undo_is_hard_negative_overriding_outcome():
    r = compute_action_reward("pause_campaign",
                              pre_roas=Decimal("0.5"), post_roas=Decimal("0"),
                              pre_profit_cents=-30000, post_profit_cents=0,
                              break_even_roas=Decimal("1.5"), undone=True)
    assert r == UNDO_PENALTY
