"""Slice #3 — unit coverage of the moat-train HTTP entrypoint core.

Mirrors tests/engine/test_core.py: the transport-agnostic ``handle`` is
exercised with the DB pool, ETL, and trainer faked out, so we test the auth
gate, the run order (ETL then train), and the response shape without a live
database. The cohort/cold-start behaviour itself is proven DB-backed in
tests/engine/integration/test_threshold_trainer_cohort_db.py.
"""
from __future__ import annotations

import asyncio
from datetime import date

import _moat_train_core as core


class _FakeConn:
    """Stand-in asyncpg connection: the ETL/trainer are faked, so the only
    method the core actually calls on it is ``transaction()`` (a no-op CM)."""

    def transaction(self):
        class _Txn:
            async def __aenter__(self_inner):
                return None

            async def __aexit__(self_inner, *exc):
                return False

        return _Txn()


class _FakePool:
    def __init__(self) -> None:
        self.closed = False

    def acquire(self):
        class _Acq:
            async def __aenter__(self_inner):
                return _FakeConn()

            async def __aexit__(self_inner, *exc):
                return False

        return _Acq()

    async def close(self) -> None:
        self.closed = True


class _Ctx:
    def __init__(self) -> None:
        self.pool: _FakePool | None = None
        self.calls: list[str] = []  # records call order: etl, peer_metrics, train
        self.etl_kwargs = None
        self.peer_metrics_kwargs = None
        self.train_kwargs = None


class _FakeEtlReport:
    """Minimal stand-in mirroring EtlReport's attributes used by the core."""

    def __init__(self) -> None:
        self.alerts_projected = 3
        self.baselines_written = 1
        self.baselines_suppressed = 2
        self.incidents_extracted = 0


def _run(body, auth, monkeypatch, *, secret="s3cret", pepper="pep"):
    monkeypatch.setenv("CRON_SECRET", secret)
    monkeypatch.setenv("DATABASE_URL", "postgresql://unused")
    if pepper is not None:
        monkeypatch.setenv("MOAT_PEPPER", pepper)
    else:
        monkeypatch.delenv("MOAT_PEPPER", raising=False)
    ctx = _Ctx()

    async def fake_make_pool(url, **kwargs):
        ctx.pool = _FakePool()
        return ctx.pool

    async def fake_etl(conn, *, run_date, pepper):
        ctx.calls.append("etl")
        ctx.etl_kwargs = {"run_date": run_date, "pepper": pepper}
        return _FakeEtlReport()

    async def fake_peer_metrics(conn, *, run_date, pepper):
        ctx.calls.append("peer_metrics")
        ctx.peer_metrics_kwargs = {"run_date": run_date, "pepper": pepper}
        return None

    async def fake_train(conn, *, pepper, run_date, **kwargs):
        ctx.calls.append("train")
        ctx.train_kwargs = {"pepper": pepper, "run_date": run_date}
        return {
            "shops_trained": 4,
            "models_written": 40,
            "skipped": 1,
            "errors": ["shopX/det: boom"],
        }

    monkeypatch.setattr(core, "make_pool", fake_make_pool)
    monkeypatch.setattr(core, "run_peer_incident_etl", fake_etl)
    monkeypatch.setattr(core, "run_peer_metrics", fake_peer_metrics)
    monkeypatch.setattr(core, "train_thresholds", fake_train)
    status, payload = asyncio.run(core.handle(body, auth))
    return status, payload, ctx


def test_rejects_missing_auth(monkeypatch):
    status, payload, ctx = _run({}, None, monkeypatch)
    assert status == 401
    # Unauthorized requests must never touch the DB.
    assert ctx.pool is None


def test_rejects_wrong_auth(monkeypatch):
    status, payload, ctx = _run({}, "Bearer nope", monkeypatch)
    assert status == 401
    assert ctx.pool is None


def test_rejects_when_no_cron_secret_configured(monkeypatch):
    # Absent CRON_SECRET in the environment => deny everything (fail closed).
    monkeypatch.delenv("CRON_SECRET", raising=False)
    monkeypatch.setenv("DATABASE_URL", "postgresql://unused")
    ctx = _Ctx()

    async def fake_make_pool(url, **kwargs):
        ctx.pool = _FakePool()
        return ctx.pool

    monkeypatch.setattr(core, "make_pool", fake_make_pool)
    status, payload = asyncio.run(core.handle({}, "Bearer anything"))
    assert status == 401
    assert ctx.pool is None


def test_success_runs_etl_then_train_and_returns_summary(monkeypatch):
    status, payload, ctx = _run({}, "Bearer s3cret", monkeypatch)
    assert status == 200
    # Run order: incident ETL, then peer-metric baselines, then the trainer
    # (the night's full job — all under one cron/transaction).
    assert ctx.calls == ["etl", "peer_metrics", "train"]
    # Peer-metrics gets the same pepper + run_date as the rest of the night.
    assert ctx.peer_metrics_kwargs["pepper"] == "pep"
    assert ctx.peer_metrics_kwargs["run_date"] == ctx.train_kwargs["run_date"]
    # Response shape: nested etl report + flattened trainer summary.
    assert payload["etl"] == {
        "alerts_projected": 3,
        "baselines_written": 1,
        "baselines_suppressed": 2,
        "incidents_extracted": 0,
    }
    assert payload["shops_trained"] == 4
    assert payload["models_written"] == 40
    assert payload["skipped"] == 1
    assert payload["errors"] == ["shopX/det: boom"]
    # Same pepper + run_date threaded into both stages.
    assert ctx.etl_kwargs["pepper"] == "pep"
    assert ctx.train_kwargs["pepper"] == "pep"
    assert ctx.etl_kwargs["run_date"] == ctx.train_kwargs["run_date"]
    assert isinstance(ctx.train_kwargs["run_date"], date)
    # The per-invocation pool is always closed (finally).
    assert ctx.pool.closed is True


def test_missing_pepper_is_503_and_does_not_run_job(monkeypatch):
    # The whole moat job is a no-op without MOAT_PEPPER (it keys every write);
    # fail loudly with 503 rather than silently writing nothing.
    status, payload, ctx = _run({}, "Bearer s3cret", monkeypatch, pepper=None)
    assert status == 503
    assert "MOAT_PEPPER" in payload.get("error", "")
    assert ctx.calls == []  # neither stage ran
    assert ctx.pool is None  # never opened the pool
