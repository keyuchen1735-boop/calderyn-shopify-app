"""Plan 05 slice #5 — peer + incident ETL orchestrator.

Additive to the fixed moat kernels (emitter, peer_baselines,
incident_extractor). Builds the cross-tenant anonymized arm:
projection -> per-(detector, GMV-band) baselines -> incident library.
"""

from __future__ import annotations

import json
import re as _re
from dataclasses import dataclass
from datetime import date
from decimal import Decimal as _Decimal
from typing import Any

import structlog

from .incident_extractor import extract_incident
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


@dataclass
class EtlReport:
    """Per-night ETL outcome counts (for #4's observability / fail-visibly)."""
    alerts_projected: int
    baselines_written: int
    baselines_suppressed: int
    incidents_extracted: int


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


async def compute_peer_baselines_by_segment(
    conn: Any, detector_id: str, segment: str
) -> int:
    """Per-(detector, segment) peer-quartile baseline.

    Mirrors ``moat.peer_baselines.compute_peer_baselines`` SQL shape,
    K_FLOOR, and upsert verbatim, but restricts the observation set to
    rows whose ``payload->>'segment'`` equals ``segment``. Additive — the
    fixed kernel is left untouched (it is still used by consent_purge).

    A2: the ``consenting`` CTE filters to ``peer_data_consent = true``.
    A3: a row is written only when ``count(distinct pseudonym_id) >= K_FLOOR``.
    Returns the contributor count, or 0 when the floor was not met.
    """
    row = await conn.fetchrow(
        """
        with consenting as (
          select sp.pseudonym_id
            from moat_keys.shop_pseudonym sp
            join public.shops s on s.id = sp.shop_id
           where s.peer_data_consent = true
        ),
        observations as (
          select e.pseudonym_id,
                 (e.payload->>'dollar_impact')::numeric as dollar_impact
            from moat.event_log e
            join consenting c on c.pseudonym_id = e.pseudonym_id
           where e.detector_id = $1
             and e.event_kind = 'detection_fired'
             and e.payload ? 'dollar_impact'
             and e.payload->>'segment' = $2
        ),
        agg as (
          select
            count(distinct pseudonym_id) as n,
            percentile_cont(0.25) within group (order by dollar_impact) as p25,
            percentile_cont(0.50) within group (order by dollar_impact) as p50,
            percentile_cont(0.75) within group (order by dollar_impact) as p75
          from observations
        )
        select n, p25, p50, p75 from agg
        """,
        detector_id, segment,
    )
    if row is None:
        return 0
    n_value = int(row["n"] or 0)
    if n_value < K_FLOOR:
        logger.info(
            "peer_baselines_skipped_k_floor",
            detector_id=detector_id, segment=segment,
            n=n_value, k_floor=K_FLOOR,
        )
        return 0
    await conn.execute(
        """
        INSERT INTO moat.peer_baselines
          (detector_id, segment, p25, p50, p75, n, computed_at)
        VALUES ($1, $2, $3, $4, $5, $6, now())
        ON CONFLICT (detector_id, segment) DO UPDATE SET
          p25 = EXCLUDED.p25, p50 = EXCLUDED.p50, p75 = EXCLUDED.p75,
          n = EXCLUDED.n, computed_at = EXCLUDED.computed_at
        """,
        detector_id, segment, row["p25"], row["p50"], row["p75"], n_value,
    )
    logger.info(
        "peer_baselines_upserted",
        detector_id=detector_id, segment=segment, n=n_value,
    )
    return n_value


async def run_peer_baselines(conn: Any) -> tuple[int, int]:
    """Recompute baselines for every (detector, segment) with projected data.

    Returns (written, suppressed): how many (detector, segment) pairs got a
    row vs. how many were k-floored.
    """
    pairs = await conn.fetch(
        """
        SELECT DISTINCT detector_id, payload->>'segment' AS segment
          FROM moat.event_log
         WHERE event_kind = 'detection_fired'
           AND detector_id IS NOT NULL
           AND payload ? 'segment'
        """
    )
    written = 0
    suppressed = 0
    for p in pairs:
        n = await compute_peer_baselines_by_segment(conn, p["detector_id"], p["segment"])
        if n >= K_FLOOR:
            written += 1
        else:
            suppressed += 1
    return written, suppressed


def _loss_usd_from_note(note: str | None) -> _Decimal:
    """Parse the confirmed-loss USD out of the feedback note ('loss=<n>').

    ``public.alert_feedback`` has no dedicated loss column (verified), so the
    amount rides on the note. Falls back to 0 when unparseable so a malformed
    note never crashes the night (the extractor still records the pattern; the
    dollar anchor is then 0).
    """
    if not note:
        return _Decimal("0")
    m = _re.search(r"loss=([0-9]+(?:\.[0-9]+)?)", note)
    return _Decimal(m.group(1)) if m else _Decimal("0")


async def run_incident_library(conn: Any, *, run_date: date) -> int:
    """Harvest the day's consenting-shop confirmed losses into the library.

    A2: only consenting shops' confirmed losses are considered. Dedup +
    PII-stripping are handled inside extract_incident. Returns the number
    of new library rows inserted.
    """
    losses = await conn.fetch(
        """
        SELECT f.alert_id::text AS alert_id, f.note
          FROM public.alert_feedback f
          JOIN public.shops s ON s.id = f.shop_id
         WHERE s.peer_data_consent = true
           AND f.kind = 'confirmed_loss'
           AND f.created_at >= $1::date
           AND f.created_at <  ($1::date + interval '1 day')
        """,
        run_date,
    )
    inserted = 0
    for row in losses:
        wrote = await extract_incident(
            conn, row["alert_id"], _loss_usd_from_note(row["note"])
        )
        if wrote:
            inserted += 1
    logger.info("peer_etl_incidents", run_date=run_date.isoformat(), inserted=inserted)
    return inserted


async def run_peer_incident_etl(
    conn: Any, *, run_date: date, pepper: str
) -> EtlReport:
    """Run the nightly cross-tenant ETL: project -> baselines -> incidents.

    Caller owns the transaction (this function does not BEGIN/COMMIT) and
    supplies ``pepper`` (this function never reads env). Any sub-step error
    propagates to the caller so a failed night rolls back as a unit.
    """
    projected = await project_alerts_for_day(conn, run_date=run_date, pepper=pepper)
    written, suppressed = await run_peer_baselines(conn)
    incidents = await run_incident_library(conn, run_date=run_date)
    report = EtlReport(
        alerts_projected=projected,
        baselines_written=written,
        baselines_suppressed=suppressed,
        incidents_extracted=incidents,
    )
    logger.info(
        "peer_etl_complete",
        run_date=run_date.isoformat(),
        alerts_projected=projected,
        baselines_written=written,
        baselines_suppressed=suppressed,
        incidents_extracted=incidents,
    )
    return report


__all__ = [
    "GMV_BANDS",
    "EtlReport",
    "segment_for_shop",
    "gmv_band_for_shop",
    "project_alerts_for_day",
    "compute_peer_baselines_by_segment",
    "run_peer_baselines",
    "run_incident_library",
    "run_peer_incident_etl",
]
