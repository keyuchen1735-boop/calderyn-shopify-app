import asyncio
import _core


def _run(body, auth, monkeypatch, fake_ids=("a1", "a2"), secret="s3cret"):
    monkeypatch.setenv("CRON_SECRET", secret)
    monkeypatch.setenv("DATABASE_URL", "postgresql://unused")

    async def fake_run_for_shop(shop_id, **kwargs):
        fake_run_for_shop.called_with = (shop_id, kwargs)
        return list(fake_ids)

    class _FakePool:
        async def close(self):
            pass

    async def fake_make_pool(url, **kwargs):
        return _FakePool()

    monkeypatch.setattr(_core, "run_for_shop", fake_run_for_shop)
    monkeypatch.setattr(_core, "make_pool", fake_make_pool)
    return asyncio.run(_core.handle(body, auth))


def test_rejects_missing_auth(monkeypatch):
    status, payload = _run({"shop_id": "x"}, None, monkeypatch)
    assert status == 401


def test_rejects_wrong_auth(monkeypatch):
    status, payload = _run({"shop_id": "x"}, "Bearer nope", monkeypatch)
    assert status == 401


def test_rejects_missing_shop_id(monkeypatch):
    status, payload = _run({}, "Bearer s3cret", monkeypatch)
    assert status == 400


def test_runs_pipeline_and_returns_ids(monkeypatch):
    status, payload = _run({"shop_id": "shop-1"}, "Bearer s3cret", monkeypatch)
    assert status == 200
    assert payload == {"shop_id": "shop-1", "alert_ids": ["a1", "a2"]}
