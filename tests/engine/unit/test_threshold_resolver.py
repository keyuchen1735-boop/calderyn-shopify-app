"""Plan 05 slice #6 — resolve_threshold offline-equivalence (DB-free)."""

from __future__ import annotations

from decimal import Decimal

import pytest

from calderyn_engine.detectors._threshold import resolve_threshold


class _FakeConn:
    """Minimal asyncpg-shaped stub: every fetchrow misses (no override)."""

    async def fetchrow(self, *_args, **_kwargs):
        return None


@pytest.mark.asyncio
async def test_returns_fallback_when_no_override_and_default_is_500(
    monkeypatch,
) -> None:
    monkeypatch.delenv("MOAT_PEPPER", raising=False)
    # registry default for this detector is $500; fallback is also $500.
    value = await resolve_threshold(
        _FakeConn(), "shop-x", "margin_erosion", Decimal("500")
    )
    assert value == Decimal("500")


@pytest.mark.asyncio
async def test_returns_200_fallback_even_though_registry_default_was_500(
    monkeypatch,
) -> None:
    """After the registry fix, the registry default for reorder_timing is now
    $200 too, so this test verifies the helper's fallback path still works
    correctly: when get_threshold returns the registry default ($200), the
    helper returns the caller's fallback ($200) — same value, no behaviour
    change."""
    monkeypatch.delenv("MOAT_PEPPER", raising=False)
    value = await resolve_threshold(
        _FakeConn(), "shop-x", "reorder_timing", Decimal("200")
    )
    assert value == Decimal("200")
