import asyncio
import _core


class _FakePool:
    def __init__(self):
        self.closed = False

    async def close(self):
        self.closed = True


class _Ctx:
    """Captured test doubles so assertions can inspect side effects."""

    def __init__(self):
        self.pool = None
        self.run_args = None  # (shop_id, kwargs) passed to run_for_shop


def _run(body, auth, monkeypatch, fake_ids=("a1", "a2"), secret="s3cret"):
    monkeypatch.setenv("CRON_SECRET", secret)
    monkeypatch.setenv("DATABASE_URL", "postgresql://unused")
    ctx = _Ctx()

    async def fake_run_for_shop(shop_id, **kwargs):
        ctx.run_args = (shop_id, kwargs)
        return list(fake_ids)

    async def fake_make_pool(url, **kwargs):
        ctx.pool = _FakePool()
        return ctx.pool

    monkeypatch.setattr(_core, "run_for_shop", fake_run_for_shop)
    monkeypatch.setattr(_core, "make_pool", fake_make_pool)
    status, payload = asyncio.run(_core.handle(body, auth))
    return status, payload, ctx


def test_rejects_missing_auth(monkeypatch):
    status, payload, ctx = _run({"shop_id": "x"}, None, monkeypatch)
    assert status == 401
    # Unauthorized requests must never touch the DB.
    assert ctx.pool is None


def test_rejects_wrong_auth(monkeypatch):
    status, payload, ctx = _run({"shop_id": "x"}, "Bearer nope", monkeypatch)
    assert status == 401
    assert ctx.pool is None


def test_rejects_missing_shop_id(monkeypatch):
    status, payload, ctx = _run({}, "Bearer s3cret", monkeypatch)
    assert status == 400
    assert ctx.pool is None


def test_rejects_invalid_uuid_shop_id(monkeypatch):
    # A malformed shop_id must be rejected at the boundary (clean 400), not
    # surface deep in the pipeline as an asyncpg cast error / 500.
    status, payload, ctx = _run({"shop_id": "not-a-uuid"}, "Bearer s3cret", monkeypatch)
    assert status == 400
    assert ctx.pool is None


_VALID_SHOP_ID = "00000000-0000-0000-0000-000000000001"


def test_runs_pipeline_and_returns_ids(monkeypatch):
    status, payload, ctx = _run({"shop_id": _VALID_SHOP_ID}, "Bearer s3cret", monkeypatch)
    assert status == 200
    assert payload == {"shop_id": _VALID_SHOP_ID, "alert_ids": ["a1", "a2"]}
    # run_for_shop received the shop id and the injected pool/cfg kwargs.
    assert ctx.run_args[0] == _VALID_SHOP_ID
    assert "pool" in ctx.run_args[1]
    assert "cfg" in ctx.run_args[1]
    # The per-invocation pool is always closed (the finally block).
    assert ctx.pool.closed is True
