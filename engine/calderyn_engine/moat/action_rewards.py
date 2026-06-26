"""D1 — pure reward kernel for the autopilot action trainer (spec 2026-06-19 §4).

Numbers in, Decimal reward out. No I/O. Mirrors moat/rewards.py. Sign: positive
== the action helped. Undo (merchant veto) overrides the outcome math.
"""
from __future__ import annotations
from decimal import Decimal

UNDO_PENALTY: Decimal = Decimal("-100")  # flat veto; mirrors FALSE_POSITIVE_PENALTY scale

_DEFENSIVE = {"pause_campaign", "reduce_campaign_budget"}

def compute_action_reward(
    action_kind: str,
    pre_roas: Decimal, post_roas: Decimal,
    pre_profit_cents: int, post_profit_cents: int,
    break_even_roas: Decimal,
    undone: bool,
) -> Decimal:
    if undone:
        return UNDO_PENALTY

    if action_kind in _DEFENSIVE:
        # Loss averted: only credit when the campaign WAS below break-even.
        if pre_roas < break_even_roas and pre_profit_cents < 0:
            return (Decimal(-pre_profit_cents) / 100)  # the bleed we stopped, in dollars
        return Decimal("0")

    if action_kind in ("increase_campaign_budget", "reallocate_budget", "resume_campaign"):
        delta = Decimal(post_profit_cents - pre_profit_cents) / 100
        # Penalise growth that runs below break-even (increase_campaign_budget and
        # resume_campaign): if post ROAS fell below BE, the profit delta is treated
        # as the loss it is. reallocate_budget is excluded from this penalty branch
        # (its post-state profit delta is taken at face value).
        if action_kind in ("increase_campaign_budget", "resume_campaign") and post_roas < break_even_roas:
            return delta if delta < 0 else -delta
        return delta

    return Decimal("0")  # unknown kind -> no signal (do not raise; mirrors moat)
