import pytest
from datetime import date, datetime, timezone
from decimal import Decimal

from calderyn_engine.moat.persist_action_rewards import persist_action_rewards


class _RecordingConn:
    def __init__(self, rows):
        self._rows = rows
        self.writes = []  # (action_id, reward_signal, closed_at)

    async def fetch(self, sql, *args):
        s = sql.strip()
        if s.startswith("SELECT a.id"):
            return self._rows
        if s.startswith("SELECT campaign_id"):
            return []
        return []

    async def execute(self, sql, *args):
        self.writes.append(args)


@pytest.mark.asyncio
async def test_persists_only_closed_window_rewards(monkeypatch):
    # One closed (4d old pause), one open (today). Only the closed one is written.
    closed = {
        "id": "a1", "action_kind": "pause_campaign", "campaign_id": "c1",
        "created_at": datetime(2026, 6, 22, tzinfo=timezone.utc),
        "detector_id": "campaign_below_breakeven",
        "old_budget_cents": 1000, "new_budget_cents": 0, "undone": False,
    }
    open_row = dict(closed, id="a2", created_at=datetime(2026, 6, 26, tzinfo=timezone.utc))
    conn = _RecordingConn([closed, open_row])
    n = await persist_action_rewards(conn, "shop1", date(2026, 6, 26))
    assert n == 1
    assert conn.writes[0][0] == "a1"  # action_id of the closed row
