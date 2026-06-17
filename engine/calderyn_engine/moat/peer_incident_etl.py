"""Plan 05 slice #5 — peer + incident ETL orchestrator.

Additive to the fixed moat kernels (emitter, peer_baselines,
incident_extractor). Builds the cross-tenant anonymized arm:
projection -> per-(detector, GMV-band) baselines -> incident library.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Any

import structlog

from .peer_baselines import K_FLOOR  # single source of truth for the floor

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
