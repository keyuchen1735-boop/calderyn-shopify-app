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
