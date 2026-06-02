# apps/engine/calderyn_engine/alerts_repo.py
"""Idempotent alert + evidence upsert.

Plan 03 Task 5: ``upsert_alert`` writes one row to ``alerts`` keyed by
``(shop_id, detector_id, entity_ref, day_bucket)`` and one row to
``alert_context`` keyed by ``alert_id``. Both statements use ON CONFLICT
DO UPDATE so re-running a detector for the same day refreshes the impact /
narrative / evidence in place rather than producing duplicates.
"""
from __future__ import annotations

import json
from datetime import date

import asyncpg

from calderyn_engine.schemas import AlertRow

UPSERT_SQL = """
INSERT INTO alerts (
    shop_id, detector_id, entity_ref, severity,
    dollar_impact, day_bucket, claude_narrative, claude_rank,
    first_seen_at, last_seen_at
)
VALUES ($1::uuid, $2, $3::jsonb, $4, $5, $6, $7, $8, now(), now())
ON CONFLICT (shop_id, detector_id, entity_ref, day_bucket)
DO UPDATE SET
    dollar_impact   = EXCLUDED.dollar_impact,
    severity        = EXCLUDED.severity,
    claude_narrative = EXCLUDED.claude_narrative,
    claude_rank     = EXCLUDED.claude_rank,
    last_seen_at    = now()
RETURNING id
"""

# alert_id is uuid (returned from alerts.id RETURNING above as uuid.UUID via
# asyncpg's codec); shop_id arrives as a string and needs an explicit cast.
UPSERT_CTX_SQL = """
INSERT INTO alert_context (alert_id, shop_id, evidence)
VALUES ($1, $2::uuid, $3::jsonb)
ON CONFLICT (alert_id) DO UPDATE SET evidence = EXCLUDED.evidence
"""


async def upsert_alert(conn: asyncpg.Connection, row: AlertRow) -> str:
    """Insert-or-update one alert + its evidence row, returning the alert id."""
    # asyncpg's date codec wants a real datetime.date, not the ISO string we
    # carry on the AlertRow boundary. Parse here so callers can keep the str.
    day_bucket = (
        row.day_bucket
        if isinstance(row.day_bucket, date)
        else date.fromisoformat(row.day_bucket)
    )
    rec = await conn.fetchrow(
        UPSERT_SQL,
        row.shop_id,
        row.detector_id,
        json.dumps(row.entity_ref),
        row.severity,
        row.dollar_impact,
        day_bucket,
        row.claude_narrative,
        row.claude_rank,
    )
    alert_id = rec["id"]
    await conn.execute(
        UPSERT_CTX_SQL, alert_id, row.shop_id, json.dumps(row.evidence)
    )
    return str(alert_id)
