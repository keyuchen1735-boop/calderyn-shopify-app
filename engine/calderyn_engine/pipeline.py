"""End-to-end detection pipeline: fetch → detect → rank → upsert.

Plan 03 Task 19. ``run_for_shop`` is the single entry point used by both
the CLI runner and the FastAPI dev endpoint. It:

1. Acquires a connection from the module-level asyncpg pool (one pool per
   process — see :func:`calderyn_engine.db.get_pool`).
2. Opens an RLS-scoped transaction via
   :func:`calderyn_engine.db.with_shop_context`. Every SELECT and every
   INSERT inside the block sees only ``shop_id``'s rows.
3. Iterates :data:`DETECTOR_REGISTRY` and awaits each detector's
   ``detect(shop_id, conn, now)`` coroutine. A detector failure is logged
   but does not abort the run — other detectors still get a chance.
4. Calls :func:`calderyn_engine.claude_layer.rank_and_narrate` once for
   the full batch so Claude sees every detection at once and can rank
   across detector ids.
5. Pairs each ``DetectionResult`` with its ranked counterpart on
   ``(detector_id, entity_ref)`` and upserts an :class:`AlertRow` via
   :func:`calderyn_engine.alerts_repo.upsert_alert`.

Returns the list of upserted alert ids in detection order. The ids are
also logged via structlog for observability.

Importing this module triggers a side effect: every detector module is
imported so its ``@register(...)`` decorator runs and the registry is
populated. Without these imports, the registry would still be empty when
the pipeline iterates it.
"""

from __future__ import annotations

import json
from datetime import date, datetime, UTC
from typing import Any

import structlog

from calderyn_engine.alerts_repo import load_active_narratives, upsert_alert
from calderyn_engine.campaign_grade_repo import grade_campaigns_for_shop
from calderyn_engine.claude_layer import rank_and_narrate
from calderyn_engine.config import Config, load_config
from calderyn_engine.db import get_pool, with_shop_context
from calderyn_engine.detectors import DETECTOR_REGISTRY
from calderyn_engine.schemas import AlertRow, ClaudeOutput, DetectionResult
from calderyn_engine.tracing import get_tracer

# Plan 07 Task 12 — module-level tracer. When OTel is not initialised
# this is a no-op tracer; the with-blocks below are still safe.
_tracer = get_tracer(__name__)

# Eagerly import every detector so its ``@register(DETECTOR_ID)`` decorator
# fires and the global registry is populated by the time the pipeline
# iterates it. Without these imports nothing is registered.
from calderyn_engine.detectors import (  # noqa: E402, F401
    ad_tax_overload,
    campaign_below_breakeven,
    campaign_scaling_opportunity,
    cogs_drift,
    inventory_untracked,
    margin_erosion,
    missing_cost,
    negative_unit_economics,
    out_of_stock_live,
    priced_below_cost,
    regional_shortage_risk,
    regional_spend_starved_stock,
    reorder_timing,
    return_rate_hidden_loss,
    scaling_sku_fulfillment_risk,
    sku_stockout_vs_spend,
    thin_margin,
    wrong_location_concentration,
)

logger = structlog.get_logger()


def _entity_key(entity_ref: dict[str, Any]) -> str:
    """Canonicalise an entity_ref to a string key for rank lookup."""
    return json.dumps(entity_ref, sort_keys=True, default=str)


async def run_for_shop(
    shop_id: str,
    day: date | None = None,
    *,
    cfg: Config | None = None,
    claude_client: Any | None = None,
    pool: Any | None = None,
) -> list[str]:
    """Run all registered detectors for ``shop_id`` and persist the alerts.

    Parameters
    ----------
    shop_id:
        The tenant uuid (string form) the run is scoped to. Drives both
        the RLS GUC and every detector's WHERE clause.
    day:
        The day_bucket to write into ``alerts``. Defaults to ``utcnow``'s
        calendar date so the daily idempotency key is stable for the
        natural "today" run.
    cfg:
        Optional engine config. When omitted, loaded from the environment
        via :func:`load_config`.
    claude_client:
        Test-injected Anthropic client surface (must expose
        ``.messages.create``). When ``None`` the Claude layer constructs a
        real :class:`AsyncAnthropic`. Tests pass a mock.
    pool:
        Test-injected asyncpg pool. Production callers omit this and the
        function calls :func:`calderyn_engine.db.get_pool` to pick up the
        process-wide cached pool. Tests pass the per-test pool from the
        ``pg_pool`` fixture so the pipeline writes against the same
        connection set the fixture cleans up.

    Returns
    -------
    list[str]
        The alert ids returned by ``upsert_alert`` in detection order.
    """

    cfg = cfg or load_config()
    now = datetime.now(UTC)
    day_bucket = (day or now.date()).isoformat()

    if pool is None:
        pool = await get_pool(cfg.database_url)
    upserted: list[str] = []

    # Plan 07 Task 12 — outer span for the entire shop run. The no-op
    # tracer makes this free when OTel is not initialised; production
    # exporters surface the span in the spec §10 dashboards. We use the
    # __enter__/__exit__ pair (rather than a ``with`` block) so we don't
    # have to re-indent the long async-with body below.
    _span_cm = _tracer.start_as_current_span("engine.run_for_shop")
    _span = _span_cm.__enter__()
    if _span is not None and hasattr(_span, "set_attribute"):
        _span.set_attribute("calderyn.shop_id", shop_id)
        _span.set_attribute("calderyn.day_bucket", day_bucket)
    try:
        async with pool.acquire() as conn:
            # One with_shop_context for the entire run. Detectors are read-only
            # (each wrapped in its own savepoint inside _run_detectors_in_scope)
            # and writes happen in the same transaction so RLS sees a stable
            # app.shop_id throughout. We previously nested two with_shop_context
            # blocks on the same connection, which on asyncpg cleared the GUC
            # at the inner block's COMMIT and silently broke RLS for the writes.
            async with with_shop_context(conn, shop_id):
                all_detections = await _run_detectors_in_scope(
                    conn, shop_id, now
                )

                # Campaign grade pass — derived fact, written in the same RLS
                # scope as the alerts, and BEFORE the no-detections early return
                # so grades are produced even for shops with zero alerts.
                # Savepoint-guarded so a grade failure never loses alert writes.
                gsp = conn.transaction()
                await gsp.start()
                try:
                    graded = await grade_campaigns_for_shop(
                        conn, shop_id, (day or now.date())
                    )
                except Exception as exc:  # noqa: BLE001
                    await gsp.rollback()
                    logger.error(
                        "campaign_grade_failed",
                        shop_id=shop_id,
                        error=str(exc),
                        exc_type=type(exc).__name__,
                    )
                else:
                    await gsp.commit()
                    logger.info(
                        "campaign_grades_written",
                        shop_id=shop_id,
                        count=len(graded),
                    )

                if not all_detections:
                    logger.info(
                        "pipeline_no_detections",
                        shop_id=shop_id,
                        day=day_bucket,
                    )
                    return upserted

                # Reuse stored narratives for ongoing conditions so Claude is
                # only called for genuinely new complex findings.
                cached = await load_active_narratives(conn, shop_id)
                ranked = await rank_and_narrate(
                    all_detections, cfg, client=claude_client, cached=cached
                )
                rank_map = _rank_map(ranked)

                for d in all_detections:
                    ranked_item = rank_map.get(
                        (d.detector_id, _entity_key(d.entity_ref))
                    )
                    row = AlertRow(
                        shop_id=shop_id,
                        detector_id=d.detector_id,
                        entity_ref=d.entity_ref,
                        severity=d.severity,
                        dollar_impact=d.dollar_impact,
                        day_bucket=day_bucket,
                        claude_narrative=(
                            ranked_item.narrative if ranked_item else None
                        ),
                        claude_rank=ranked_item.rank if ranked_item else None,
                        evidence=d.evidence,
                    )
                    alert_id = await upsert_alert(conn, row)
                    upserted.append(alert_id)
                    logger.info(
                        "pipeline_upserted",
                        shop_id=shop_id,
                        detector_id=d.detector_id,
                        alert_id=alert_id,
                        rank=row.claude_rank,
                    )

        logger.info(
            "pipeline_complete",
            shop_id=shop_id,
            day=day_bucket,
            detections=len(all_detections),
            upserted=len(upserted),
        )
        return upserted
    finally:
        # Close the OTel span exactly once. ``_span_cm.__exit__(None,
        # None, None)`` is the documented pair for the
        # ``__enter__``-then-``try`` pattern.
        _span_cm.__exit__(None, None, None)


async def _run_detectors_in_scope(
    conn: Any, shop_id: str, now: datetime
) -> list[DetectionResult]:
    """Iterate the registry and collect every detector's output.

    Caller must already hold ``with_shop_context(conn, shop_id)`` open.
    A detector that raises is logged and skipped. We want one bad SQL
    plan or upstream-data hiccup to never take down the entire run for a
    shop — the cost of missing alerts from the broken detector is much
    smaller than the cost of dropping every other detector's findings.

    Each detector runs inside its own savepoint so a SQL-level error in
    one detector does not poison the surrounding transaction and abort
    every later detector's queries with InFailedSQLTransactionError.
    """
    out: list[DetectionResult] = []
    for detector_id, detector in DETECTOR_REGISTRY.items():
        sp = conn.transaction()
        await sp.start()
        try:
            results = await detector(shop_id, conn, now)
        except Exception as exc:  # noqa: BLE001 — explicit broad catch
            await sp.rollback()
            logger.error(
                "detector_failed",
                detector_id=detector_id,
                shop_id=shop_id,
                error=str(exc),
                exc_type=type(exc).__name__,
            )
            continue
        else:
            await sp.commit()
        logger.info(
            "detector_ran",
            detector_id=detector_id,
            shop_id=shop_id,
            result_count=len(results),
        )
        out.extend(results)
    return out


def _rank_map(
    ranked: ClaudeOutput,
) -> dict[tuple[str, str], Any]:
    """Index the Claude output by ``(detector_id, canonical entity_ref)``.

    The rank+narrative for a detection is matched on its detector_id and
    a sorted-key JSON dump of its entity_ref. Anything Claude (or the
    fallback) returns for an unknown key is silently ignored — the
    coverage check inside ``claude_layer`` already trips the fallback if
    Claude tries to invent detections.
    """
    return {
        (item.detector_id, _entity_key(item.entity_ref)): item
        for item in ranked.ranked
    }
