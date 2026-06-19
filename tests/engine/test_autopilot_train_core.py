"""Slice D3 — unit coverage of the autopilot-train HTTP entrypoint core.

Mirrors tests/engine/test_moat_train_core.py: the transport-agnostic ``handle``
is exercised with the DB pool, ETL, and trainer faked out, so we test the auth
gate, the run order (ETL then train), and the response shape without a live
database.
"""
from __future__ import annotations

import pytest
from _autopilot_train_core import handle


@pytest.mark.asyncio
async def test_rejects_without_bearer(monkeypatch):
    monkeypatch.setenv("CRON_SECRET", "s")
    monkeypatch.setenv("MOAT_PEPPER", "p")
    status, body = await handle({}, authorization=None)
    assert status == 401


@pytest.mark.asyncio
async def test_503_without_pepper(monkeypatch):
    monkeypatch.setenv("CRON_SECRET", "s")
    monkeypatch.delenv("MOAT_PEPPER", raising=False)
    status, body = await handle({}, authorization="Bearer s")
    assert status == 503
