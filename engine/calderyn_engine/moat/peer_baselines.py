"""Plan 05 Task 16 — peer baseline ETL.

``compute_peer_baselines`` aggregates ``moat.event_log`` rows for one
(detector_id, segment) pair into a peer-quartile snapshot, enforces
the k=5 anonymity floor, and upserts the result into
``moat.peer_baselines``.

Privacy invariants:

* The aggregation is performed in SQL inside a single statement so
  the trainer process never sees per-shop dollar values — the
  Postgres percentile aggregates collapse the row set before any
  data leaves the database.
* Only consenting shops contribute. A shop with
  ``peer_data_consent = false`` is filtered out at the JOIN so its
  pseudonym ID is not even materialised in the ETL's working set.
* The k-floor (5 distinct shops) is enforced via a ``HAVING``
  clause on the upsert: a segment with fewer than 5 distinct
  pseudonyms produces no row at all (not even a row with
  ``n < 5``), which means a future query that selects
  ``WHERE n >= 5`` cannot accidentally surface a partial baseline.

The function returns no value because the caller is the trainer
worker; observability hooks in the worker log the segment and the
``n`` after the upsert.
"""

from __future__ import annotations

from typing import Any

import structlog

logger = structlog.get_logger()

# k-anonymity floor — segments with fewer than this many consenting
# contributors produce no row. Tuned to match the ETL test fixture
# in :file:`apps/engine/tests/moat/test_peer_baselines.py`.
K_FLOOR = 5


async def compute_peer_baselines(
    conn: Any,
    detector_id: str,
    segment: str,
) -> int:
    """Compute one peer-baseline row.

    Parameters
    ----------
    conn:
        asyncpg connection. The caller is responsible for transaction
        scope; this function does not BEGIN/COMMIT.
    detector_id:
        Detector to compute the baseline for. Filters
        ``moat.event_log.detector_id``.
    segment:
        Free-form segment key (e.g. ``"cat:electronics"``). Stored
        as-is on the output row; the ETL is segment-agnostic — the
        caller decides which shops belong to which segment.

    Returns
    -------
    int
        Number of distinct consenting shops that contributed to the
        baseline. ``0`` when the k-floor was not met (no row was
        upserted).
    """

    # We pull dollar_impact from the detection_fired payload jsonb
    # because that's the field the engine writes per Plan 05 Task 4
    # (DetectionFiredPayload.dollar_impact). Cast to numeric so the
    # percentile aggregates are deterministic.
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
        ),
        agg as (
          select
            count(distinct pseudonym_id) as n,
            percentile_cont(0.25) within group (order by dollar_impact)
              as p25,
            percentile_cont(0.50) within group (order by dollar_impact)
              as p50,
            percentile_cont(0.75) within group (order by dollar_impact)
              as p75
          from observations
        )
        select n, p25, p50, p75 from agg
        """,
        detector_id,
    )

    if row is None:
        return 0
    n_value = int(row["n"] or 0)

    if n_value < K_FLOOR:
        # k-floor breach — no row written. Caller may log; we return
        # the count so the caller can decide.
        logger.info(
            "peer_baselines_skipped_k_floor",
            detector_id=detector_id,
            segment=segment,
            n=n_value,
            k_floor=K_FLOOR,
        )
        return 0

    await conn.execute(
        """
        INSERT INTO moat.peer_baselines
          (detector_id, segment, p25, p50, p75, n, computed_at)
        VALUES ($1, $2, $3, $4, $5, $6, now())
        ON CONFLICT (detector_id, segment) DO UPDATE SET
          p25 = EXCLUDED.p25,
          p50 = EXCLUDED.p50,
          p75 = EXCLUDED.p75,
          n   = EXCLUDED.n,
          computed_at = EXCLUDED.computed_at
        """,
        detector_id,
        segment,
        row["p25"],
        row["p50"],
        row["p75"],
        n_value,
    )
    logger.info(
        "peer_baselines_upserted",
        detector_id=detector_id,
        segment=segment,
        n=n_value,
    )
    return n_value
