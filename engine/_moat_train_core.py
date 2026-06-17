"""Transport-agnostic core for the moat nightly trainer Vercel function.

Mirrors engine/_core.py: kept separate from api/engine/moat_train.py so the
auth gate + job invocation are unit-testable without an HTTP server. The
handler in moat_train.py is a thin adapter over handle().

The full nightly moat job, in order (umbrella section 9.3):
  1. run_peer_incident_etl  — pseudonymized projection -> per-segment peer
     baselines (consent + k>=5) -> incident library.
  2. train_thresholds       — seed each (shop, detector) posterior from the
     peer baseline, fold the shop's own reward signal, upsert
     moat.detection_models.

Returns HTTP 200 with the combined summary; the CRON caller decides failure
on a non-empty ``errors`` list (per-(shop, detector) failures are surfaced,
never swallowed — rule 12).
"""
from __future__ import annotations

import hmac
import os
import sys
from datetime import date, datetime, timezone
from typing import Any

# Ensure the vendored package (sibling dir) is importable when Vercel loads
# this file as a standalone function. Guarded so repeated imports (e.g. under
# pytest, where conftest already inserts this dir) don't pile up sys.path
# entries. Mirrors engine/_core.py.
_engine_dir = os.path.dirname(__file__)
if _engine_dir not in sys.path:
    sys.path.insert(0, _engine_dir)

from calderyn_engine.config import load_config  # noqa: E402
from calderyn_engine.db import make_pool  # noqa: E402
from calderyn_engine.moat.peer_incident_etl import run_peer_incident_etl  # noqa: E402
from calderyn_engine.moat.threshold_trainer import train_thresholds  # noqa: E402


def _authorized(authorization: str | None) -> bool:
    secret = os.environ.get("CRON_SECRET")
    if not secret:
        return False
    # Constant-time compare so the bearer check can't be probed byte-by-byte.
    return hmac.compare_digest(authorization or "", f"Bearer {secret}")


def _run_date() -> date:
    """The night's logical run date (UTC). Isolated for testability."""
    return datetime.now(timezone.utc).date()


async def handle(
    body: dict[str, Any], authorization: str | None
) -> tuple[int, dict[str, Any]]:
    """Run the full nightly moat job. Returns (status, json-body).

    Body is ignored (the cohort is enumerated server-side); it accepts ``{}``.
    """
    if not _authorized(authorization):
        return 401, {"error": "unauthorized"}

    # MOAT_PEPPER keys every cross-tenant write (pseudonym derivation + the
    # detection_models PK). Without it the job would silently produce nothing,
    # so fail loud rather than report a hollow success (rule 12).
    pepper = os.environ.get("MOAT_PEPPER")
    if not pepper:
        return 503, {"error": "MOAT_PEPPER is not configured"}

    run_date = _run_date()

    cfg = load_config()
    # Fresh pool per invocation: asyncpg pools bind to the event loop, and a
    # serverless invocation gets a fresh loop, so a cached cross-loop pool
    # would error. Short-lived pool, closed in finally. Mirrors engine/_core.py.
    pool = await make_pool(cfg.database_url, max_size=4)
    try:
        async with pool.acquire() as conn:
            # The ETL does delete+reinsert and documents "caller owns the
            # transaction" — wrap it so a failed night rolls back as a unit.
            async with conn.transaction():
                etl_report = await run_peer_incident_etl(
                    conn, run_date=run_date, pepper=pepper
                )
            # The trainer is pgbouncer transaction-pooler safe: it opens its
            # OWN short transaction per (shop, detector). It must therefore run
            # OUTSIDE any wrapping transaction — never inside one big txn.
            summary = await train_thresholds(
                conn, pepper=pepper, run_date=run_date
            )
    finally:
        await pool.close()

    return 200, {
        "etl": {
            "alerts_projected": etl_report.alerts_projected,
            "baselines_written": etl_report.baselines_written,
            "baselines_suppressed": etl_report.baselines_suppressed,
            "incidents_extracted": etl_report.incidents_extracted,
        },
        "shops_trained": summary["shops_trained"],
        "models_written": summary["models_written"],
        "skipped": summary["skipped"],
        "errors": summary["errors"],
    }
