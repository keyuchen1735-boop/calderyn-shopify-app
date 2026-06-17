"""Peer Benchmarks ETL — merchant-facing "your store vs your niche".

Reuses the moat k-floor + pseudonym machinery. KPIs are read from the shared
``public.v_peer_kpi_*`` views so this writer and the TS reader compute the same
number. Privacy (A1): the cross-tenant aggregate sees only (pseudonym, segment,
value) — never raw shop_id.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Any

import structlog

from .peer_baselines import K_FLOOR
from .pseudonym import pseudonym_for

logger = structlog.get_logger()


async def category_niche_for_shop(conn: Any, shop_id: str, run_date: date) -> str:
    """Return ``cat:<category>`` for the shop's dominant category by trailing-90d
    GMV (sum of ``sku_pnl.revenue_cents`` joined to ``sku_dim.category``).

    Ties break alphabetically (deterministic — required by the moat re-aggregate
    / purge paths). No qualifying sales → ``cat:uncategorized``.

    Mirrors ``public.v_peer_shop_niche`` (current_date); kept in Python here
    because the ETL is run_date-parameterized. ``test_resolver_matches_niche_view
    _for_today`` guards the two encodings against drift.
    """
    row = await conn.fetchrow(
        """
        select sd.category
          from public.sku_pnl p
          join public.sku_dim sd on sd.id = p.sku_id
         where p.shop_id = $1::uuid
           and sd.category is not null
           and p.day >= ($2::date - interval '90 days')
           and p.day <  ($2::date + interval '1 day')
         group by sd.category
         order by sum(p.revenue_cents) desc, sd.category asc
         limit 1
        """,
        shop_id, run_date,
    )
    if row is None or row["category"] is None:
        return "cat:uncategorized"
    return f"cat:{row['category']}"


# KPI key -> shared public view. Fixed allowlist (never user input) — the
# f-string interpolation below is therefore injection-safe.
METRIC_VIEWS: dict[str, str] = {
    "aov": "public.v_peer_kpi_aov",
    "return_rate": "public.v_peer_kpi_return_rate",
    "gross_margin_pct": "public.v_peer_kpi_gross_margin_pct",
    "ship_cost_pct": "public.v_peer_kpi_ship_cost_pct",
}

# A1: aggregate over pseudonyms + values only, never raw shop_id.
_AGG_SQL = """
with vals(pseudonym, segment, value) as (
  select * from unnest($1::text[], $2::text[], $3::numeric[])
)
select segment,
       count(distinct pseudonym) as n,
       percentile_cont(0.25) within group (order by value) as p25,
       percentile_cont(0.50) within group (order by value) as p50,
       percentile_cont(0.75) within group (order by value) as p75
  from vals
 group by segment
"""


@dataclass(frozen=True)
class PeerMetricsReport:
    metrics_written: int
    segments_deleted: int


async def _shop_values(conn: Any, view: str, shop_ids: list) -> dict[str, Any]:
    rows = await conn.fetch(
        f"select shop_id, value from {view} where shop_id = any($1::uuid[])",
        shop_ids,
    )
    return {str(r["shop_id"]): r["value"] for r in rows if r["value"] is not None}


async def run_peer_metrics(conn: Any, *, run_date: date, pepper: str) -> PeerMetricsReport:
    """Recompute every (metric_key, segment) baseline from the currently
    consenting shops. Idempotent. Caller owns the transaction and supplies the
    pepper (never reads env). delete-stale removes any segment that no longer
    reaches K_FLOOR (GDPR + churn)."""
    consenting = await conn.fetch(
        "select id from public.shops where peer_data_consent = true"
    )
    shop_ids = [r["id"] for r in consenting]

    if not shop_ids:
        # Nobody consents → table must be empty.
        deleted = 0
        for metric_key in METRIC_VIEWS:
            res = await conn.execute(
                "delete from moat.peer_metric_baselines where metric_key = $1",
                metric_key,
            )
            try:
                deleted += int(res.split()[-1])
            except (ValueError, IndexError):
                pass
        logger.info("peer_metrics_no_consent", segments_deleted=deleted)
        return PeerMetricsReport(metrics_written=0, segments_deleted=deleted)

    pseudonym = {str(sid): pseudonym_for(str(sid), pepper) for sid in shop_ids}
    niche: dict[str, str] = {}
    for sid in shop_ids:
        seg = await category_niche_for_shop(conn, sid, run_date)
        if seg != "cat:uncategorized":  # uncategorized never contributes (spec §2)
            niche[str(sid)] = seg

    written = 0
    deleted = 0
    for metric_key, view in METRIC_VIEWS.items():
        values = await _shop_values(conn, view, shop_ids)
        ps: list[str] = []
        segs: list[str] = []
        vals: list = []
        for sid_str, seg in niche.items():
            v = values.get(sid_str)
            if v is None:
                continue
            ps.append(pseudonym[sid_str])
            segs.append(seg)
            vals.append(v)

        rows = await conn.fetch(_AGG_SQL, ps, segs, vals)
        qualifying: set[str] = set()
        for row in rows:
            n = int(row["n"])
            if n < K_FLOOR:
                continue
            qualifying.add(row["segment"])
            await conn.execute(
                """
                insert into moat.peer_metric_baselines
                  (metric_key, segment, p25, p50, p75, n, computed_at)
                values ($1, $2, $3, $4, $5, $6, now())
                on conflict (metric_key, segment) do update set
                  p25 = excluded.p25, p50 = excluded.p50, p75 = excluded.p75,
                  n = excluded.n, computed_at = excluded.computed_at
                """,
                metric_key, row["segment"], row["p25"], row["p50"], row["p75"], n,
            )
            written += 1

        # delete-stale: any persisted segment for this metric that did NOT
        # re-qualify this run (dropped below K_FLOOR or vanished).
        existing = await conn.fetch(
            "select segment from moat.peer_metric_baselines where metric_key = $1",
            metric_key,
        )
        for er in existing:
            if er["segment"] not in qualifying:
                await conn.execute(
                    "delete from moat.peer_metric_baselines "
                    "where metric_key = $1 and segment = $2",
                    metric_key, er["segment"],
                )
                deleted += 1

    logger.info("peer_metrics_complete", metrics_written=written, segments_deleted=deleted)
    return PeerMetricsReport(metrics_written=written, segments_deleted=deleted)
