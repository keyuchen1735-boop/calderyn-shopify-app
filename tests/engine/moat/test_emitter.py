"""Plan 05 Task 6 — unit-level coverage of ``emit_moat_event`` against
a hand-rolled mock asyncpg connection. Mirrors the five cases in
``packages/shared/src/moat/emitter.test.ts``:

    1. happy path                    -> writes one row, returns True
    2. consent=False on gated kind   -> skips, returns False
    3. payload validation failure    -> raises (loud failure)
    4. missing pseudonym             -> inserts mapping, then writes
    5. unknown event_kind            -> raises (loud failure)
"""
from __future__ import annotations

from typing import Any

import pytest
from pydantic import ValidationError

from calderyn_engine.moat.emitter import emit_moat_event

SHOP_ID = "11111111-1111-4111-8111-111111111111"
ALERT_ID = "22222222-2222-4222-8222-222222222222"
PEPPER = "pepper-test-1"


class _Recorder:
    """Tiny stand-in for an asyncpg.Connection.

    Records every fetchrow/execute call and supports a queue of
    fetchrow results so we can simulate the "row exists" vs "row
    missing" branches inside ``_resolve_pseudonym``.
    """

    def __init__(self) -> None:
        self.calls: list[tuple[str, str, tuple[Any, ...]]] = []
        self.fetchrow_queue: list[Any] = []

    async def fetchrow(self, sql: str, *args: Any) -> Any:
        self.calls.append(("fetchrow", sql, args))
        if not self.fetchrow_queue:
            return None
        return self.fetchrow_queue.pop(0)

    async def execute(self, sql: str, *args: Any) -> str:
        self.calls.append(("execute", sql, args))
        return "INSERT 0 1"

    def calls_matching(self, needle: str) -> list[tuple[str, str, tuple[Any, ...]]]:
        return [c for c in self.calls if needle in c[1]]


@pytest.mark.asyncio
async def test_happy_path_writes_one_row() -> None:
    rec = _Recorder()
    rec.fetchrow_queue.append({"pseudonym_id": "p_existing"})

    wrote = await emit_moat_event(
        rec,
        shop_id=SHOP_ID,
        kind="detection_fired",
        detector_id="sku_stockout_vs_spend",
        payload={
            "detector_id": "sku_stockout_vs_spend",
            "alert_id": ALERT_ID,
            "severity": "high",
            "dollar_impact": 100,
            "thresholds_used": {"min_spend_usd": 500},
        },
        pepper=PEPPER,
        peer_data_consent=True,
    )

    assert wrote is True
    assert rec.calls_matching("insert into moat.event_log")


@pytest.mark.asyncio
async def test_consent_gate_skips_alert_feedback() -> None:
    rec = _Recorder()

    wrote = await emit_moat_event(
        rec,
        shop_id=SHOP_ID,
        kind="alert_feedback",
        payload={
            "alert_id": ALERT_ID,
            "feedback_kind": "confirmed_loss",
            "confirmed_loss_usd": 100,
        },
        pepper=PEPPER,
        peer_data_consent=False,
    )

    assert wrote is False
    # No SQL at all — gating happens before any DB round-trip.
    assert rec.calls == []


@pytest.mark.asyncio
async def test_payload_validation_raises() -> None:
    rec = _Recorder()
    with pytest.raises(ValidationError):
        await emit_moat_event(
            rec,
            shop_id=SHOP_ID,
            kind="detection_fired",
            # missing required fields
            payload={"detector_id": "sku_stockout_vs_spend"},
            pepper=PEPPER,
            peer_data_consent=True,
        )
    assert not rec.calls_matching("insert into moat.event_log")


@pytest.mark.asyncio
async def test_missing_pseudonym_inserts_mapping_then_writes() -> None:
    rec = _Recorder()
    # Empty queue -> first fetchrow returns None -> fallback path.

    wrote = await emit_moat_event(
        rec,
        shop_id=SHOP_ID,
        kind="detection_fired",
        detector_id="sku_stockout_vs_spend",
        payload={
            "detector_id": "sku_stockout_vs_spend",
            "alert_id": ALERT_ID,
            "severity": "high",
            "dollar_impact": 100,
            "thresholds_used": {},
        },
        pepper=PEPPER,
        peer_data_consent=True,
    )

    assert wrote is True
    assert rec.calls_matching("insert into moat_keys.shop_pseudonym")
    assert rec.calls_matching("insert into moat.event_log")


@pytest.mark.asyncio
async def test_unknown_kind_raises() -> None:
    rec = _Recorder()
    with pytest.raises(ValueError, match="unknown kind"):
        await emit_moat_event(
            rec,
            shop_id=SHOP_ID,
            kind="bogus_kind",
            payload={},
            pepper=PEPPER,
            peer_data_consent=True,
        )
    assert rec.calls == []
