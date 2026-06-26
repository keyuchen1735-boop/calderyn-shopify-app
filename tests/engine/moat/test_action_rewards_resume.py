from decimal import Decimal
from calderyn_engine.moat.action_rewards import compute_action_reward


def test_resume_credits_profit_when_above_breakeven():
    # Resumed a campaign; post profit > pre, ROAS above break-even -> positive.
    r = compute_action_reward("resume_campaign", Decimal("3"), Decimal("3"),
                              0, 5000, Decimal("2"), False)
    assert r == Decimal("50")  # +$50 profit delta


def test_resume_penalizes_when_below_breakeven():
    # Resumed but it runs below break-even -> the "gain" is treated as a loss.
    r = compute_action_reward("resume_campaign", Decimal("3"), Decimal("1"),
                              0, 5000, Decimal("2"), False)
    assert r < 0


def test_resume_undo_is_hard_negative():
    r = compute_action_reward("resume_campaign", Decimal("3"), Decimal("3"),
                              0, 5000, Decimal("2"), True)
    assert r == Decimal("-100")
