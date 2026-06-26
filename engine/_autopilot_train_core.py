"""Transport-agnostic core for the autopilot nightly trainer Vercel function.

Mirrors engine/_moat_train_core.py: kept separate from
api/engine/autopilot_train.py so the auth gate + job invocation are
unit-testable without an HTTP server. The handler in autopilot_train.py is a
thin adapter over handle().

The full nightly autopilot job, in order (umbrella section D3):
  1. run_action_peer_etl  — pseudonymized projection -> per-segment peer
     action-aggressiveness baselines (consent + k>=5).
  2. train_action_policies — seed each (shop, detector, action_kind) posterior
     from the peer baseline, fold the shop's own reward signal, upsert
     moat.action_models.

Returns HTTP 200 with the combined summary; the CRON caller decides failure
on a non-empty ``errors`` list (per-(shop, detector/action) failures are
surfaced, never swallowed — rule 12).
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
# entries. Mirrors engine/_moat_train_core.py.
_engine_dir = os.path.dirname(__file__)
if _engine_dir not in sys.path:
    sys.path.insert(0, _engine_dir)

from calderyn_engine.config import load_config  # noqa: E402
from calderyn_engine.db import make_pool  # noqa: E402
from calderyn_engine.moat.action_peer_etl import run_action_peer_etl  # noqa: E402
from calderyn_engine.moat.action_trainer import train_action_policies  # noqa: E402
from calderyn_engine.moat.persist_action_rewards import persist_action_rewards  # noqa: E402


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
    """Run the full nightly autopilot job. Returns (status, json-body).

    Body is ignored (the cohort is enumerated server-side); it accepts ``{}``.
    """
    if not _authorized(authorization):
        return 401, {"error": "unauthorized"}

    # MOAT_PEPPER keys every cross-tenant write (pseudonym derivation + the
    # action_models PK). Without it the job would silently produce nothing,
    # so fail loud rather than report a hollow success (rule 12).
    pepper = os.environ.get("MOAT_PEPPER")
    if not pepper:
        return 503, {"error": "MOAT_PEPPER is not configured"}

    run_date = _run_date()

    cfg = load_config()
    # Fresh pool per invocation: asyncpg pools bind to the event loop, and a
    # serverless invocation gets a fresh loop, so a cached cross-loop pool
    # would error. Short-lived pool, closed in finally. Mirrors engine/_moat_train_core.py.
    pool = await make_pool(cfg.database_url, max_size=4)
    try:
        async with pool.acquire() as conn:
            # The ETL does delete+reinsert and documents "caller owns the
            # transaction" — wrap it so a failed night rolls back as a unit.
            async with conn.transaction():
                etl_report = await run_action_peer_etl(
                    conn, run_date=run_date, pepper=pepper
                )
            # The trainer is pgbouncer transaction-pooler safe: it opens its
            # OWN short transaction per (shop, detector, action_kind). It must
            # therefore run OUTSIDE any wrapping transaction — never inside one
            # big txn.
            summary = await train_action_policies(
                conn, pepper=pepper, run_date=run_date
            )

            # Persist closed-window reward signs back to action_audit for every
            # shop in the cohort. Uses the same shop enumeration query as
            # train_action_policies (shops with consent OR autopilot history).
            # Fail-visible per shop; errors are appended to the returned list
            # and never abort the run (rule 12 / idempotent CRON contract).
            persist_errors: list[str] = []
            rewards_persisted = 0
            shop_rows = await conn.fetch(
                "SELECT DISTINCT s.id::text AS shop_id FROM public.shops s "
                "LEFT JOIN public.action_audit a ON a.shop_id = s.id AND a.actor_user_id='autopilot' "
                "WHERE s.peer_data_consent = true OR a.shop_id IS NOT NULL"
            )
            for sr in shop_rows:
                shop_id = sr["shop_id"]
                try:
                    rewards_persisted += await persist_action_rewards(conn, shop_id, run_date)
                except Exception as exc:  # noqa: BLE001
                    persist_errors.append(f"persist_rewards {shop_id}: {exc}")

    finally:
        await pool.close()

    return 200, {
        "etl": {
            "baselines_written": etl_report["baselines_written"],
            "groups_suppressed": etl_report["groups_suppressed"],
        },
        "shops_trained": summary["shops_trained"],
        "models_written": summary["models_written"],
        "skipped": summary["skipped"],
        "errors": summary["errors"] + persist_errors,
        "rewards_persisted": rewards_persisted,
    }
