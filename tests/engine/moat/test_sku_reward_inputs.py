# Task 16: SKU-scoped reward input derivation. Fake-conn unit tests in the same
# canned-rows-by-SQL-prefix style as tests/engine/moat/test_action_reward_inputs_window.py.
#
# The SKU actions query is aliased `SELECT s.id ...` (action_audit AS s) so its
# prefix is distinct from the campaign path's `SELECT a.id ...` — this keeps the
# fake-conn dispatch unambiguous and avoids colliding with the campaign-scoped
# _RecordingConn in test_persist_action_rewards.py. The economics query starts
# `SELECT ol.sku_id ...`. See the spike findings header in
# test_sku_action_rewards.py for the confirmed params/columns.
from datetime import date, datetime, timezone
from decimal import Decimal

import pytest

from calderyn_engine.moat.sku_reward_inputs import derive_sku_action_reward_inputs


class _FakeConn:
    """Minimal asyncpg-like stub: SKU actions by prefix, per-window econ by call."""

    def __init__(self, actions, econ_by_call):
        self._actions = actions
        # econ_by_call: list of canned _SKU_ECON_SQL results, consumed in order.
        self._econ = list(econ_by_call)

    async def fetch(self, sql, *args):
        s = sql.strip()
        if s.startswith("SELECT s.id"):
            return self._actions
        if s.startswith("SELECT ol.sku_id"):
            return self._econ.pop(0) if self._econ else []
        raise AssertionError(f"unexpected SQL: {s[:40]!r}")


def _action(**over):
    base = {
        "id": "act1",
        "action_kind": "adjust_price",
        "created_at": datetime(2026, 6, 17, tzinfo=timezone.utc),  # 9 days ago
        "sku_id": "sku1",
        "to_location_id": None,
        "delta": None,
        "detector_id": "margin_erosion",
        "undone": False,
    }
    base.update(over)
    return base


@pytest.mark.asyncio
async def test_adjust_price_credits_margin_improvement_when_window_closed():
    # adjust_price has a 7-day window. Action 2026-06-17, run 2026-06-26 -> closed.
    # Pre unit margin $5 (500c), post $8 (800c), 100 units post -> +$300.
    conn = _FakeConn(
        actions=[_action(action_kind="adjust_price")],
        econ_by_call=[
            [{"sku_id": "sku1", "units": 80, "unit_margin_cents": 500}],   # pre
            [{"sku_id": "sku1", "units": 100, "unit_margin_cents": 800}],  # post
        ],
    )
    rows = await derive_sku_action_reward_inputs(conn, "shop1", date(2026, 6, 26))
    assert len(rows) == 1
    r = rows[0]
    assert r["action_kind"] == "adjust_price"
    assert r["detector_id"] == "margin_erosion"
    assert r["campaign_id"] == ""  # SKU actions carry no campaign
    assert r["window_closed"] is True
    assert r["reward"] == Decimal("300")
    assert r["action_id"] == "act1"


@pytest.mark.asyncio
async def test_discontinue_credits_averted_bleed():
    # discontinue_sku: pre unit econ -$3 (-300c) over 200 units -> +$600 averted.
    conn = _FakeConn(
        actions=[_action(action_kind="discontinue_sku", id="d1", sku_id="sku2")],
        econ_by_call=[
            [{"sku_id": "sku2", "units": 200, "unit_margin_cents": -300}],  # pre
            [],                                                             # post (retired)
        ],
    )
    rows = await derive_sku_action_reward_inputs(conn, "shop1", date(2026, 6, 26))
    assert len(rows) == 1
    assert rows[0]["reward"] == Decimal("600")


@pytest.mark.asyncio
async def test_reallocate_inventory_credits_dest_sales():
    # reallocate_inventory (7-day window): 40 units at $5 margin post -> +$200
    # (source_stockout_units = 0 in v1).
    conn = _FakeConn(
        actions=[_action(action_kind="reallocate_inventory", id="r1", sku_id="sku3")],
        econ_by_call=[
            [{"sku_id": "sku3", "units": 40, "unit_margin_cents": 500}],  # post only
        ],
    )
    rows = await derive_sku_action_reward_inputs(conn, "shop1", date(2026, 6, 26))
    assert len(rows) == 1
    assert rows[0]["action_kind"] == "reallocate_inventory"
    assert rows[0]["reward"] == Decimal("200")


@pytest.mark.asyncio
async def test_window_open_before_confirmation_window():
    # adjust_price 7-day window, action 2 days ago vs run -> window NOT closed.
    conn = _FakeConn(
        actions=[_action(created_at=datetime(2026, 6, 24, tzinfo=timezone.utc))],
        econ_by_call=[
            [{"sku_id": "sku1", "units": 80, "unit_margin_cents": 500}],
            [{"sku_id": "sku1", "units": 100, "unit_margin_cents": 800}],
        ],
    )
    rows = await derive_sku_action_reward_inputs(conn, "shop1", date(2026, 6, 26))
    assert rows[0]["window_closed"] is False


@pytest.mark.asyncio
async def test_undo_is_hard_negative():
    conn = _FakeConn(
        actions=[_action(undone=True)],
        econ_by_call=[
            [{"sku_id": "sku1", "units": 80, "unit_margin_cents": 500}],
            [{"sku_id": "sku1", "units": 100, "unit_margin_cents": 800}],
        ],
    )
    rows = await derive_sku_action_reward_inputs(conn, "shop1", date(2026, 6, 26))
    assert rows[0]["reward"] == Decimal("-100")
