# apps/engine/calderyn_engine/alerts_repo.py
"""Idempotent alert + evidence upsert.

``upsert_alert`` writes one row to ``alerts`` keyed by the ongoing
*condition* ``(shop_id, detector_id, entity_ref)`` and one row to
``alert_context`` keyed by ``alert_id``. The alerts upsert targets the
partial unique index ``alerts_active_condition_key`` (active statuses
only), so re-running a detector — on the same day OR a later one —
refreshes the impact / narrative / evidence / ``day_bucket`` of the same
open/acknowledged/snoozed alert rather than minting a fresh row per day.

A condition that recurs AFTER its alert was resolved/dismissed falls
outside the partial index and correctly opens a new alert. ``day_bucket``
is no longer part of the key — it records the latest day the condition was
detected.

Status on refresh: an ``acknowledged`` alert (the merchant acted, but the
detector "still owns resolution and may re-open it" — see
``app/lib/alerts.server.ts``) is flipped back to ``open`` when the condition
re-fires, so a still-true problem the merchant thought was handled returns to
the open queue. A ``snoozed`` alert keeps its status (snooze is a deliberate
timed deferral, re-surfaced by its deadline / next login, not by detection).
"""
from __future__ import annotations

import json
from datetime import date

import asyncpg

from calderyn_engine.claude_layer import entity_key
from calderyn_engine.schemas import AlertRow

UPSERT_SQL = """
INSERT INTO alerts (
    shop_id, detector_id, entity_ref, severity,
    dollar_impact, day_bucket, claude_narrative, claude_rank,
    first_seen_at, last_seen_at
)
VALUES ($1::uuid, $2, $3::jsonb, $4, $5, $6, $7, $8, now(), now())
ON CONFLICT (shop_id, detector_id, entity_ref)
    WHERE status IN ('open', 'acknowledged', 'snoozed')
DO UPDATE SET
    dollar_impact   = EXCLUDED.dollar_impact,
    severity        = EXCLUDED.severity,
    claude_narrative = EXCLUDED.claude_narrative,
    claude_rank     = EXCLUDED.claude_rank,
    day_bucket      = EXCLUDED.day_bucket,
    last_seen_at    = now(),
    -- Re-open an acknowledged alert whose condition is still firing; leave
    -- snoozed (timed deferral) and open untouched.
    status = CASE WHEN alerts.status = 'acknowledged'
                  THEN 'open'::alert_status
                  ELSE alerts.status END
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


_ACTIVE_NARRATIVES_SQL = """
SELECT detector_id, entity_ref, claude_narrative
FROM alerts
WHERE shop_id = $1::uuid
  AND status IN ('open', 'acknowledged', 'snoozed')
  AND claude_narrative IS NOT NULL
"""


async def load_active_narratives(
    conn: asyncpg.Connection, shop_id: str
) -> dict[tuple[str, str], str]:
    """Map each active alert's (detector_id, entity_key) to its stored narrative.

    The pipeline passes this to ``rank_and_narrate`` so an ongoing condition
    reuses its narrative instead of re-asking Claude. Only active statuses (the
    ones the upsert refreshes) are considered, and only rows that already have
    a narrative.
    """
    rows = await conn.fetch(_ACTIVE_NARRATIVES_SQL, shop_id)
    out: dict[tuple[str, str], str] = {}
    for r in rows:
        ref = r["entity_ref"]
        if isinstance(ref, str):
            ref = json.loads(ref)
        out[(r["detector_id"], entity_key(ref))] = r["claude_narrative"]
    return out
