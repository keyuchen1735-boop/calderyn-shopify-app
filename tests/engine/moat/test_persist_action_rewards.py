import pytest
from datetime import date, datetime, timezone
from decimal import Decimal

from calderyn_engine.moat.persist_action_rewards import persist_action_rewards
from calderyn_engine.moat.action_reward_inputs import SKU_ACTION_KINDS


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


# ---------------------------------------------------------------------------
# Regression: campaign loop must NOT touch SKU-kind rows.
#
# Production overlap: _ACTIONS_SQL previously lacked an action_kind filter, so
# the campaign loop would see discontinue_sku/adjust_price/reallocate_inventory
# rows, call compute_action_reward (returns 0 for unknown kinds), and write
# reward_signal=0 + reward_window_closed_at=now(). The SKU loop then ran but
# _UPDATE_SQL's "reward_window_closed_at IS NULL" guard failed -> no-op.
# Net: every closed-window SKU reward was silently written as 0 in production.
#
# The fix adds "AND a.action_kind <> ALL($2)" to _ACTIONS_SQL. The fake conn
# below enforces this: if the SQL contains the exclusion clause it filters out
# SKU rows from the campaign query; if the clause is absent it returns them
# (so deleting the fix causes the test to fail).
# ---------------------------------------------------------------------------


class _OverlapConn:
    """Fake conn that reproduces the production double-write scenario."""

    _SKU_ROW = {
        "id": "sku-act1",
        "action_kind": "adjust_price",
        "created_at": datetime(2026, 6, 17, tzinfo=timezone.utc),  # 9d ago; 7d window -> closed
        "sku_id": "sku1",
        "to_location_id": None,
        "delta": None,
        "detector_id": "margin_erosion",
        "undone": False,
        # campaign-path columns (ignored by SKU path):
        "campaign_id": None,
        "old_budget_cents": None,
        "new_budget_cents": None,
    }

    def __init__(self):
        self.writes: list[tuple] = []

    async def fetch(self, sql: str, *args):
        s = sql.strip()

        if s.startswith("SELECT a.id"):
            # Campaign path. Honour the exclusion clause only if it is present.
            # If someone removes the fix, "sku-act1" leaks through here.
            excluded = "<> ALL" in s or "NOT IN" in s
            if excluded:
                return []  # SKU row correctly excluded
            else:
                return [self._SKU_ROW]  # fix removed -> bug reintroduced

        if s.startswith("SELECT s.id"):
            # SKU path — always returns the SKU action.
            return [self._SKU_ROW]

        if s.startswith("SELECT ol.sku_id"):
            # Economics for adjust_price: pre then post calls (consumed in order).
            # pre: 500c/unit, 80 units; post: 800c/unit, 100 units -> reward = 300
            if not hasattr(self, "_econ_calls"):
                self._econ_calls = 0
            self._econ_calls += 1
            if self._econ_calls % 2 == 1:
                return [{"sku_id": "sku1", "units": 80, "unit_margin_cents": 500}]
            return [{"sku_id": "sku1", "units": 100, "unit_margin_cents": 800}]

        # campaign_grade_fact, ad_spend_fact etc.
        return []

    async def execute(self, sql: str, *args):
        self.writes.append(args)


@pytest.mark.asyncio
async def test_sku_reward_not_stomped_by_campaign_loop():
    """SKU action must be written once with its correct reward (not 0)."""
    conn = _OverlapConn()
    n = await persist_action_rewards(conn, "shop1", date(2026, 6, 26))

    # Exactly one write should occur (the SKU loop's correct reward).
    assert n == 1, f"expected 1 write, got {n}"

    assert len(conn.writes) == 1, (
        f"expected 1 execute call, got {len(conn.writes)}: {conn.writes}"
    )
    action_id, reward_signal, shop_id = conn.writes[0]
    assert action_id == "sku-act1"
    assert reward_signal == Decimal("300"), (
        f"expected reward 300, got {reward_signal} — "
        "campaign loop may have written 0 first (double-write bug)"
    )
    assert shop_id == "shop1"
