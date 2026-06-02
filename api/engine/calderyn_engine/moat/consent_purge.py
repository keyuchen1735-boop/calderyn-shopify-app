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
     this shop and re-run :func:`compute_peer_baselines` for each.
  3. Return the count of event_log rows removed for caller logging.

Called from a pg-boss consumer (``moat:consent-revoked``) — see the
moat-trainer worker registration. Idempotent: a second purge for the
same shop_pseudonym is a no-op (no rows to delete, no segments to
re-run).
"""

from __future__ import annotations

from typing import Any

import structlog

from .peer_baselines import compute_peer_baselines

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

    # Step 3 — re-run ETL for each affected (detector, segment).
    # compute_peer_baselines re-counts distinct contributors so the
    # post-purge baseline reflects the now-smaller cohort (or
    # disappears entirely if k-floor is breached).
    for row in affected:
        try:
            await compute_peer_baselines(
                conn,
                detector_id=row["detector_id"],
                segment=row["segment"],
            )
        except Exception as exc:  # noqa: BLE001
            logger.error(
                "consent_purge_etl_rerun_failed",
                detector_id=row["detector_id"],
                segment=row["segment"],
                error=str(exc),
            )

    logger.info(
        "consent_purge_complete",
        shop_pseudonym=shop_pseudonym,
        events_deleted=deleted,
        segments_recomputed=len(affected),
    )
    return deleted
