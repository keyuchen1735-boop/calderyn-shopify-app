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
