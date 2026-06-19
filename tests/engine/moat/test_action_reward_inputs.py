import pytest
from decimal import Decimal
from datetime import date
from calderyn_engine.moat.action_reward_inputs import derive_action_reward_inputs, ActionRewardInput

class FakeConn:
    def __init__(self, actions, spend, grade): self._a, self._s, self._g = actions, spend, grade
    async def fetch(self, q, *args):
        if "action_audit" in q: return self._a
        if "ad_spend_fact" in q: return self._s
        return self._g

@pytest.mark.asyncio
async def test_derives_reward_input_with_chosen_pct_and_reward():
    actions = [{
        "id": "act1", "detector_id": "ad_tax_overload", "action_kind": "reduce_campaign_budget",
        "campaign_id": "c1", "created_at": "2026-06-01T00:00:00+00:00",
        "old_budget_cents": 10000, "new_budget_cents": 7000, "undone": False,
    }]
    spend = [
        {"campaign_id": "c1", "phase": "pre", "spend_cents": 20000, "revenue_cents": 5000},
        {"campaign_id": "c1", "phase": "post", "spend_cents": 7000, "revenue_cents": 7000},
    ]
    grade = [{"campaign_id": "c1", "break_even_roas": Decimal("1.5")}]
    rows = await derive_action_reward_inputs(FakeConn(actions, spend, grade), "shop1", date(2026, 6, 19))
    assert len(rows) == 1
    r = rows[0]
    assert r["action_kind"] == "reduce_campaign_budget"
    assert r["chosen_pct"] == pytest.approx(30.0)  # (10000-7000)/10000
    assert r["reward"] > 0  # loss averted (pre roas 0.25 < BE 1.5, pre profit negative)
