import pytest
from decimal import Decimal
from datetime import date
from calderyn_engine.moat import action_trainer
from calderyn_engine.moat.action_trainer import _mu_from_posterior, train_action_policies

def test_cold_start_mu_lands_on_peer_p50():
    baseline = {"p25": Decimal("0.2"), "p50": Decimal("0.5"), "p75": Decimal("0.8"), "n": 5}
    mu = _mu_from_posterior({"alpha": 1.0, "beta": 1.0}, baseline)  # mean 0.5
    assert mu == pytest.approx(0.5)  # exactly p50

def test_no_baseline_falls_back_to_full_cap():
    assert _mu_from_posterior({"alpha": 1.0, "beta": 1.0}, None) == 1.0

class _Tx:
    async def __aenter__(self): return self
    async def __aexit__(self, *a): return False

class FakeConn:
    def __init__(self, cohort, baseline):
        self._cohort, self._baseline, self.upserts = cohort, baseline, []
    def transaction(self): return _Tx()
    async def fetch(self, q, *args):
        if "action_baselines" in q:  # _coldstart_keys
            return [{"detector_id": "ad_tax_overload", "action_kind": "reduce_campaign_budget"}] if self._baseline else []
        if "peer_data_consent" in q:  # cohort enumeration
            return [{"shop_id": s} for s in self._cohort]
        return []
    async def fetchrow(self, q, *args):
        if "action_baselines" in q:  # _read_baseline
            return self._baseline
        return None
    async def execute(self, q, *args):
        self.upserts.append(args)

@pytest.mark.asyncio
async def test_train_writes_model_row(monkeypatch):
    async def fake_rewards(conn, shop_id, run_date):
        return [{"shop_id": shop_id, "detector_id": "ad_tax_overload", "action_kind": "reduce_campaign_budget",
                 "campaign_id": "c", "chosen_pct": 30.0, "reward": Decimal("100"), "action_id": "a1"}]
    async def fake_band(conn, shop_id, run_date):
        return "gmv:mid"
    monkeypatch.setattr(action_trainer, "derive_action_reward_inputs", fake_rewards)
    monkeypatch.setattr(action_trainer, "gmv_band_for_shop", fake_band)
    conn = FakeConn(cohort=["s1"], baseline={"p25": Decimal("0.2"), "p50": Decimal("0.5"), "p75": Decimal("0.8"), "n": 5})
    summary = await train_action_policies(conn, pepper="pep", run_date=date(2026, 6, 19))
    assert summary["models_written"] == 1
    assert summary["shops_trained"] == 1
    assert len(conn.upserts) == 1
