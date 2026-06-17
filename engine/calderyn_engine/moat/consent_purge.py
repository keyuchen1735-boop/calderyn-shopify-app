"""Plan 05 Task 20 — consent revocation purge.

``purge_shop_contributions`` is the single function that removes a
shop's pseudonymized contributions from every moat surface and
re-runs the affected peer-baseline rollups so the merchant is no
longer represented in any cross-tenant statistic.

Steps:

  1. Delete every ``moat.event_log`` row carrying the shop's
     pseudonym. The pseudonym → shop_id mapping in
     ``moat_keys.shop_pseudonym`` is preserved on purpose: the
     mapping is needed for the merchant to revoke and later re-grant
     consent without breaking the determinism of HMAC.
  2. Find every ``(detector_id, segment)`` pair that previously had
     a row in ``moat.peer_baselines`` whose computation included
     this shop and re-aggregate each so the withdrawn shop no longer
     influences any row.

     Slice #5 introduced PER-SEGMENT baselines keyed
     ``(detector_id, segment)`` off the in-payload ``segment`` label
     (``compute_peer_baselines_by_segment``). Those rows are
     re-aggregated through #5's machinery — NOT the detector-only
     kernel, which ignores the segment label. Legacy/opaque-segment
     rows (no ``segment`` in payload, written by the original kernel)
     are still re-aggregated by ``compute_peer_baselines`` for
     backward compatibility.

     CRITICAL (GDPR / invariants A2+A3): a ``(detector, segment)``
     baseline whose distinct consenting contributors drop BELOW the
     k>=5 floor after the purge has its ``moat.peer_baselines`` row
     DELETED — not merely left un-updated. A recompute that only
     "writes when >=5" would leave a stale row still carrying the
     withdrawn shop's influence; that is the exact privacy gap this
     purge closes.
  3. Return the count of event_log rows removed for caller logging.

Called from a pg-boss consumer (``moat:consent-revoked``) — see the
moat-trainer worker registration. Idempotent: a second purge for the
same shop_pseudonym is a no-op (no rows to delete, no segments to
re-run).
"""

from __future__ import annotations

from typing import Any

import structlog

from .peer_baselines import K_FLOOR, compute_peer_baselines
from .peer_incident_etl import recompute_or_purge_segment_baseline

logger = structlog.get_logger()


async def purge_shop_contributions(conn: Any, shop_pseudonym: str) -> int:
    """Purge a shop's contributions from moat and re-run baselines.

    Parameters
    ----------
    conn:
        asyncpg connection. Caller manages transaction scope.
    shop_pseudonym:
        The pseudonym (HMAC) for the revoking shop. The caller is
        responsible for resolving ``shop_id`` → pseudonym; this
        function never sees the raw shop_id (CLAUDE.md invariant
        #5).

    Returns
    -------
    int
        Number of rows deleted from ``moat.event_log``.
    """

    # Step 1 — capture the (detector_id, segment) pairs the shop's
    # rows participated in BEFORE we delete them. The peer_baselines
    # table is keyed by (detector_id, segment) — we have to recompute
    # every segment whose existing baseline could have included this
    # pseudonym's contributions. v1 has no per-shop segment column, so
    # we assume "this shop touched every segment we currently have
    # baselines for in any detector it fired" — the safest over-
    # approximation. ETL re-runs are cheap; false positives are fine.
    affected = await conn.fetch(
        """
        SELECT DISTINCT pb.detector_id, pb.segment
          FROM moat.peer_baselines pb
         WHERE EXISTS (
           SELECT 1 FROM moat.event_log e
            WHERE e.pseudonym_id = $1
              AND e.detector_id = pb.detector_id
         )
        """,
        shop_pseudonym,
    )

    # Step 2 — delete the event_log rows. detection_models rows are
    # NOT deleted: those are per-shop state and the merchant may
    # re-consent later, in which case the trainer should resume from
    # its existing posterior rather than relearn from scratch.
    result = await conn.execute(
        "DELETE FROM moat.event_log WHERE pseudonym_id = $1",
        shop_pseudonym,
    )
    # asyncpg returns the command tag — pull the row count out.
    try:
        deleted = int(result.split()[-1])
    except (ValueError, IndexError):
        deleted = 0

    # Step 3 — re-aggregate each affected (detector, segment) so the
    # post-purge baseline reflects the now-smaller cohort, and DELETE any
    # row that has fallen below the k>=5 floor (the GDPR delete-stale
    # requirement — A2/A3). Each pair is classified from the surviving
    # ledger rows (the withdrawn shop's rows are already gone):
    #
    #   * a row still backed by segment-labelled events
    #     (payload->>'segment' = segment) is a slice-#5 per-segment
    #     baseline -> re-aggregate via recompute_or_purge_segment_baseline
    #     (rewrites when >=5, deletes when sub-floor);
    #   * a row backed only by un-segmented events is a legacy/opaque
    #     baseline -> re-aggregate via the original detector-only kernel,
    #     then delete-stale if its contributors fell below the floor;
    #   * a row with no surviving events of either kind -> delete it.
    #
    # Re-aggregation errors are surfaced per-pair (rule 12: fail visibly)
    # but do not abort the remaining pairs; the deletion of the withdrawn
    # shop's own rows in Step 2 has already committed within the caller's
    # transaction.
    for row in affected:
        detector_id = row["detector_id"]
        segment = row["segment"]
        try:
            shape = await conn.fetchrow(
                """
                SELECT
                  bool_or(payload->>'segment' = $2)        AS has_segment_rows,
                  bool_or(NOT (payload ? 'segment'))        AS has_unsegmented_rows
                  FROM moat.event_log
                 WHERE detector_id = $1
                   AND event_kind = 'detection_fired'
                """,
                detector_id, segment,
            )
            has_segment_rows = bool(shape and shape["has_segment_rows"])
            has_unsegmented_rows = bool(shape and shape["has_unsegmented_rows"])

            if has_segment_rows:
                # Per-segment baseline — #5's machinery, with delete-stale.
                await recompute_or_purge_segment_baseline(
                    conn, detector_id, segment
                )
            elif has_unsegmented_rows:
                # Legacy/opaque-segment baseline — original detector-only
                # kernel re-aggregates; delete the row if it is now sub-floor
                # so the withdrawn shop cannot linger in it either.
                n = await compute_peer_baselines(
                    conn, detector_id=detector_id, segment=segment
                )
                if n < K_FLOOR:
                    await conn.execute(
                        "DELETE FROM moat.peer_baselines "
                        "WHERE detector_id = $1 AND segment = $2",
                        detector_id, segment,
                    )
                    logger.info(
                        "consent_purge_baseline_deleted_sub_k_floor",
                        detector_id=detector_id, segment=segment,
                        n=n, k_floor=K_FLOOR,
                    )
            else:
                # No surviving events for this detector at all — the baseline
                # cannot stand; remove it.
                await conn.execute(
                    "DELETE FROM moat.peer_baselines "
                    "WHERE detector_id = $1 AND segment = $2",
                    detector_id, segment,
                )
                logger.info(
                    "consent_purge_baseline_deleted_no_events",
                    detector_id=detector_id, segment=segment,
                )
        except Exception as exc:  # noqa: BLE001
            logger.error(
                "consent_purge_etl_rerun_failed",
                detector_id=detector_id,
                segment=segment,
                error=str(exc),
            )

    logger.info(
        "consent_purge_complete",
        shop_pseudonym=shop_pseudonym,
        events_deleted=deleted,
        segments_recomputed=len(affected),
    )
    return deleted
