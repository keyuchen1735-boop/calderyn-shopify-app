"""D2 — action peer-baseline ETL tests (monkeypatched, no DB required).

Exercises:
  - k-floor suppression: 4 shops → 0 baselines written
  - k-floor publish:     5 shops → 1 baseline written (one group)

The two seams patched are derive_action_reward_inputs (Task 6) and
gmv_band_for_shop (peer_incident_etl). FakeConn records every execute()
call so we can assert upserts without a real DB.
"""

from __future__ import annotations

import pytest
from datetime import date
from decimal import Decimal

from calderyn_engine.moat import action_peer_etl


class FakeConn:
    def __init__(self, shops, caps):
        self._shops, self._caps, self.upserts = shops, caps, []

    async def fetch(self, q, *args):
        if "peer_data_consent" in q:
            return [{"shop_id": s} for s in self._shops]
        return []

    async def fetchrow(self, q, *args):
        return self._caps

    async def execute(self, q, *args):
        self.upserts.append(args)


def _patch(monkeypatch, shops):
    async def fake_rewards(conn, shop_id, run_date):
        return [{"shop_id": shop_id, "detector_id": "ad_tax_overload",
                 "action_kind": "reduce_campaign_budget", "campaign_id": "c",
                 "chosen_pct": 30.0, "reward": Decimal("100"), "action_id": "a"}]

    async def fake_band(conn, shop_id, run_date):
        return "gmv:mid"

    monkeypatch.setattr(action_peer_etl, "derive_action_reward_inputs", fake_rewards)
    monkeypatch.setattr(action_peer_etl, "gmv_band_for_shop", fake_band)
    return FakeConn(shops, {"autopilot_max_budget_cut_pct": 50,
                            "autopilot_max_budget_increase_pct": 20})


@pytest.mark.asyncio
async def test_suppresses_baseline_below_k_floor(monkeypatch):
    conn = _patch(monkeypatch, ["s1", "s2", "s3", "s4"])  # 4 < 5
    summary = await action_peer_etl.run_action_peer_etl(conn, pepper="p", run_date=date(2026, 6, 19))
    assert summary["baselines_written"] == 0
    assert conn.upserts == []


@pytest.mark.asyncio
async def test_publishes_baseline_at_k_floor(monkeypatch):
    conn = _patch(monkeypatch, ["s1", "s2", "s3", "s4", "s5"])  # 5
    summary = await action_peer_etl.run_action_peer_etl(conn, pepper="p", run_date=date(2026, 6, 19))
    assert summary["baselines_written"] == 1
    assert len(conn.upserts) == 1  # one (segment, detector, action_kind) group published
