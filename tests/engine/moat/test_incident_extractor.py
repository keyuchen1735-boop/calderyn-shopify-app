"""Plan 05 Task 18 — coverage of ``extract_incident`` against a mock conn.

Two cases:

  1. Fresh library + first confirmed_loss → exactly one row inserted.
  2. Library already carries the same signature → no row inserted
     (returns False, ``insert into moat.incident_library`` never
     called).

We use the same hand-rolled asyncpg recorder pattern from
``tests/moat/test_emitter.py`` so the test stays pure unit (no
testcontainer) and runs in milliseconds.
"""

from __future__ import annotations

import json
from decimal import Decimal
from typing import Any

import pytest

from calderyn_engine.moat.incident_extractor import extract_incident

ALERT_ID = "11111111-1111-4111-8111-111111111111"
DETECTOR = "sku_stockout_vs_spend"


class _Recorder:
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
async def test_fresh_library_inserts_one_row() -> None:
    rec = _Recorder()
    # First fetchrow: alert lookup.
    rec.fetchrow_queue.append(
        {
            "detector_id": DETECTOR,
            "evidence": json.dumps({"days_oos": 3, "spend_window_days": 7}),
        }
    )
    # Second fetchrow: dedupe lookup → returns None (no existing row).
    rec.fetchrow_queue.append(None)

    inserted = await extract_incident(rec, ALERT_ID, Decimal("3200"))
    assert inserted is True
    insert_calls = rec.calls_matching("INSERT INTO moat.incident_library")
    assert len(insert_calls) == 1


@pytest.mark.asyncio
async def test_near_duplicate_signature_skips_insert() -> None:
    rec = _Recorder()
    # alert lookup.
    rec.fetchrow_queue.append(
        {
            "detector_id": DETECTOR,
            "evidence": json.dumps({"days_oos": 3, "spend_window_days": 7}),
        }
    )
    # dedupe lookup → returns an existing row.
    rec.fetchrow_queue.append({"id": "existing-id"})

    inserted = await extract_incident(rec, ALERT_ID, Decimal("3200"))
    assert inserted is False
    insert_calls = rec.calls_matching("INSERT INTO moat.incident_library")
    assert insert_calls == []
