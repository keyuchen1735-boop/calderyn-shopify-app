from datetime import date, datetime, timezone
from decimal import Decimal

import pytest
from calderyn_engine.moat.action_reward_inputs import derive_action_reward_inputs


class _FakeConn:
    """Minimal asyncpg-like stub: returns canned rows per SQL prefix."""
    def __init__(self, actions, spend, grades):
        self._actions, self._spend, self._grades = actions, spend, grades

    async def fetch(self, sql, *args):
        s = sql.strip()
        if s.startswith("SELECT a.id"):
            return self._actions
        if s.startswith("SELECT campaign_id"):
            return self._spend
        return self._grades


@pytest.mark.asyncio
async def test_pause_window_closed_after_three_days(monkeypatch):
    # Action 4 days ago, pause_campaign (3-day window) -> window_closed True.
    created = datetime(2026, 6, 22, tzinfo=timezone.utc)
    conn = _FakeConn(
        actions=[{
            "id": "a1", "action_kind": "pause_campaign", "campaign_id": "c1",
            "created_at": created, "detector_id": "campaign_below_breakeven",
            "old_budget_cents": 1000, "new_budget_cents": 0, "undone": False,
        }],
        spend=[
            {"campaign_id": "c1", "phase": "pre", "spend_cents": 5000, "revenue_cents": 1000},
            {"campaign_id": "c1", "phase": "post", "spend_cents": 0, "revenue_cents": 0},
        ],
        grades=[{"campaign_id": "c1", "break_even_roas": Decimal("2")}],
    )
    rows = await derive_action_reward_inputs(conn, "shop1", date(2026, 6, 26))
    assert rows[0]["window_closed"] is True
    assert rows[0]["reward"] > 0  # loss averted on a below-break-even campaign


@pytest.mark.asyncio
async def test_pause_window_open_before_three_days():
    created = datetime(2026, 6, 25, tzinfo=timezone.utc)  # 1 day ago vs run 2026-06-26
    conn = _FakeConn(
        actions=[{
            "id": "a2", "action_kind": "pause_campaign", "campaign_id": "c1",
            "created_at": created, "detector_id": "campaign_below_breakeven",
            "old_budget_cents": 1000, "new_budget_cents": 0, "undone": False,
        }],
        spend=[], grades=[],
    )
    rows = await derive_action_reward_inputs(conn, "shop1", date(2026, 6, 26))
    assert rows[0]["window_closed"] is False
