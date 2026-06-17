"""Plan 05 slice #5 — peer + incident ETL orchestrator.

Additive to the fixed moat kernels (emitter, peer_baselines,
incident_extractor). Builds the cross-tenant anonymized arm:
projection -> per-(detector, GMV-band) baselines -> incident library.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import date
from typing import Any

import structlog

from .peer_baselines import K_FLOOR  # single source of truth for the floor
from .pseudonym import pseudonym_for

logger = structlog.get_logger()

# Trailing-90d GMV band thresholds in integer cents. A shop's band is the
# highest band whose lower bound it meets. Zero orders -> micro.
GMV_BANDS: tuple[tuple[str, int], ...] = (
    ("gmv:xl", 1_000_000_00),
    ("gmv:large", 250_000_00),
    ("gmv:mid", 50_000_00),
    ("gmv:small", 10_000_00),
    ("gmv:micro", 0),
)


def segment_for_shop(gmv_90d_cents: int) -> str:
    """Map trailing-90d GMV (integer cents) to a ``gmv:<band>`` segment."""
    for label, lower_cents in GMV_BANDS:
        if gmv_90d_cents >= lower_cents:
            return label
    return "gmv:micro"


async def gmv_band_for_shop(conn: Any, shop_id: str, run_date: date) -> str:
    """Return the ``gmv:<band>`` segment for ``shop_id`` at ``run_date``.

    Bands off trailing-90d gross merchandise value
    (sum of ``order_fact.total_cents`` in ``[run_date-90d, run_date]``).
    """
    row = await conn.fetchrow(
        """
        SELECT COALESCE(SUM(total_cents), 0)::bigint AS gmv_cents
          FROM public.order_fact
         WHERE shop_id = $1::uuid
           AND created_at_source >= ($2::date - INTERVAL '90 days')
           AND created_at_source <  ($2::date + INTERVAL '1 day')
        """,
        shop_id, run_date,
    )
    gmv_cents = int(row["gmv_cents"]) if row and row["gmv_cents"] is not None else 0
    return segment_for_shop(gmv_cents)


async def _resolve_pseudonym(conn: Any, shop_id: str, pepper: str) -> str:
    """Look up moat_keys.shop_pseudonym; insert the mapping if missing.

    Mirrors ``emitter._resolve_pseudonym`` — same lookup-then-insert under
    a deterministic HMAC, ``ON CONFLICT (shop_id) DO NOTHING`` to collapse
    the race. The projection writes the event row inline (the strict
    ``DetectionFiredPayload`` forbids the extra ``segment``/``day_bucket``
    keys the moat needs), so this slice resolves the pseudonym itself
    rather than going through ``emit_moat_event``. A1 holds: only the
    pseudonym ever reaches ``moat.event_log``; the raw ``shop_id`` stays in
    the key-vault table the baseline JOIN reads through.
    """
    row = await conn.fetchrow(
        "select pseudonym_id from moat_keys.shop_pseudonym "
        "where shop_id = $1::uuid",
        shop_id,
    )
    if row is not None:
        return row["pseudonym_id"]
    computed = pseudonym_for(shop_id, pepper)
    await conn.execute(
        "insert into moat_keys.shop_pseudonym (shop_id, pseudonym_id) "
        "values ($1::uuid, $2) on conflict (shop_id) do nothing",
        shop_id, computed,
    )
    return computed


async def project_alerts_for_day(
    conn: Any, *, run_date: date, pepper: str
) -> int:
    """Project one day's consenting-shop alerts into ``moat.event_log``.

    Idempotent: deletes this slice's prior ``detection_fired`` projection
    for ``run_date`` (keyed on the in-payload ``day_bucket``) before
    re-emitting, so N runs for a day produce exactly one row set.
    Caller owns the transaction — the delete + re-insert MUST be one txn.
    """
    # Idempotency: drop prior projection for this day only. Seed rows that
    # carry no day_bucket in payload are never matched, so they survive.
    await conn.execute(
        """
        DELETE FROM moat.event_log
         WHERE event_kind = 'detection_fired'
           AND (payload->>'day_bucket')::date = $1
        """,
        run_date,
    )

    # A2: select alerts only for consenting shops. A non-consenting shop's
    # rows are never read, so its pseudonym is never resolved.
    alerts = await conn.fetch(
        """
        SELECT a.id::text AS alert_id, a.shop_id::text AS shop_id,
               a.detector_id, a.dollar_impact, a.severity, a.day_bucket
          FROM public.alerts a
          JOIN public.shops s ON s.id = a.shop_id
         WHERE s.peer_data_consent = true
           AND a.day_bucket = $1
        """,
        run_date,
    )

    emitted = 0
    for a in alerts:
        segment = await gmv_band_for_shop(conn, a["shop_id"], run_date)
        # A1: resolve to a pseudonym BEFORE the insert; the raw shop_id is
        # never written into the moat ledger (no shop_id column exists).
        pseudonym_id = await _resolve_pseudonym(conn, a["shop_id"], pepper)
        payload = {
            "alert_id": a["alert_id"],
            "severity": a["severity"],
            "detector_id": a["detector_id"],
            "dollar_impact": float(a["dollar_impact"]),
            "thresholds_used": {},
            "day_bucket": a["day_bucket"].isoformat(),
            "segment": segment,
        }
        await conn.execute(
            "insert into moat.event_log "
            "(pseudonym_id, event_kind, detector_id, payload) "
            "values ($1, 'detection_fired', $2, $3::jsonb)",
            pseudonym_id,
            a["detector_id"],
            json.dumps(payload),
        )
        emitted += 1
    logger.info("peer_etl_projected", run_date=run_date.isoformat(), emitted=emitted)
    return emitted
