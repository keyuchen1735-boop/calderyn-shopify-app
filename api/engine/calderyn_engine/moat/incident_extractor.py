"""Plan 05 Task 18 — incident library extractor.

``extract_incident`` is invoked when an ``outcome_confirmed`` event
lands. It:

  1. Reads the alert's evidence (``public.alerts.evidence``).
  2. Computes a deterministic ``pattern_signature`` from the
     evidence + detector_id. PII-bearing fields (sku titles, ad
     copy, geo names) are excluded by allow-listing only the
     numeric / categorical keys per detector.
  3. Skips the insert when a near-duplicate signature already
     exists in ``moat.incident_library`` for the same detector.
  4. Otherwise inserts a fresh library row carrying the redacted
     narrative template.

Dormant in v1: the engine only calls this on outcome_confirmed.
Without a confirmed loss, no library row is ever written, so the
table starts empty and grows organically as merchants confirm.

Privacy invariants:
  * ``pattern_signature`` is a SHA-256 hex digest — irreversible.
  * The narrative_template never contains the source shop's
    pseudonym or any free-form merchant copy. The extractor splices
    the detector's canonical template (from the engine's detector
    module) with numeric anchors only.
"""

from __future__ import annotations

import hashlib
import json
from decimal import Decimal
from typing import Any
from collections.abc import Mapping

import structlog

logger = structlog.get_logger()


# Per-detector allow-list of evidence keys that contribute to the
# pattern signature. The keys are the structured numeric/categorical
# anchors the engine writes into ``alerts.evidence`` — anything not
# in this list is considered potentially-PII and ignored.
_SIGNATURE_KEYS: dict[str, tuple[str, ...]] = {
    "sku_stockout_vs_spend": ("days_oos", "spend_window_days"),
    "campaign_below_breakeven": ("loss_window_days",),
    "regional_spend_starved_stock": ("region_class",),
    "scaling_sku_fulfillment_risk": ("days_of_cover_bucket",),
    "return_rate_hidden_loss": ("return_rate_bucket",),
    "margin_erosion": ("erosion_bucket",),
    "cogs_drift": ("drift_bucket",),
    "ad_tax_overload": ("ratio_bucket",),
    "negative_unit_economics": ("delta_bucket",),
    "reorder_timing": ("days_late_bucket",),
    "wrong_location_concentration": ("concentration_bucket",),
    "regional_shortage_risk": ("shortage_bucket",),
}


def _signature_for(
    detector_id: str, evidence: Mapping[str, Any] | None
) -> str:
    """Compute the deterministic pattern signature.

    Reads only the allow-listed keys for the detector and feeds them
    through json + sha256. Same input → same digest, regardless of
    dict insertion order.
    """
    keys = _SIGNATURE_KEYS.get(detector_id, ())
    safe: dict[str, Any] = {"detector_id": detector_id}
    if evidence is not None:
        for key in keys:
            if key in evidence:
                safe[key] = evidence[key]
    blob = json.dumps(safe, sort_keys=True, default=str)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


async def extract_incident(
    conn: Any,
    alert_id: str,
    confirmed_loss_usd: Decimal | float | int,
) -> bool:
    """Extract one incident pattern from a confirmed-loss alert.

    Parameters
    ----------
    conn:
        asyncpg connection. Caller manages transaction scope.
    alert_id:
        ``public.alerts.id`` of the alert that received the
        ``outcome_confirmed`` event.
    confirmed_loss_usd:
        The merchant-supplied confirmed loss. Carried through to
        the narrative template so the library can later say
        "shops similar to yours saw $N loss".

    Returns
    -------
    bool
        True iff a new library row was inserted; False when a
        near-duplicate already existed.
    """

    # Evidence lives in alert_context, not alerts itself (Plan 03
    # migration 020). LEFT JOIN so an alert without context still
    # produces a row — the signature just bakes in the empty
    # evidence dict.
    alert = await conn.fetchrow(
        """
        SELECT a.detector_id, ac.evidence
          FROM public.alerts a
          LEFT JOIN public.alert_context ac ON ac.alert_id = a.id
         WHERE a.id = $1::uuid
        """,
        alert_id,
    )
    if alert is None:
        logger.warning("incident_extractor_alert_missing", alert_id=alert_id)
        return False

    detector_id = alert["detector_id"]
    raw_evidence = alert["evidence"]
    if isinstance(raw_evidence, str):
        try:
            evidence = json.loads(raw_evidence)
        except json.JSONDecodeError:
            evidence = None
    elif isinstance(raw_evidence, dict):
        evidence = raw_evidence
    else:
        evidence = None

    signature = _signature_for(detector_id, evidence)

    # Near-duplicate check: same detector + same signature already in
    # the library means this confirmed_loss carries no new pattern
    # information. v1 uses exact-signature match; the schema has a
    # similarity_threshold column reserved for a future fuzzy match.
    existing = await conn.fetchrow(
        """
        SELECT id FROM moat.incident_library
         WHERE detector_id = $1 AND pattern_signature = $2
         LIMIT 1
        """,
        detector_id,
        signature,
    )
    if existing is not None:
        logger.info(
            "incident_extractor_duplicate_skipped",
            detector_id=detector_id,
            alert_id=alert_id,
        )
        return False

    # Narrative template uses only numeric anchors — we never carry
    # the source shop's free-form text into the library.
    loss_value = Decimal(str(confirmed_loss_usd))
    template = (
        f"Pattern observed for {detector_id}: "
        f"shops with this signature confirmed approximately "
        f"${loss_value:.2f} of loss."
    )

    await conn.execute(
        """
        INSERT INTO moat.incident_library
          (detector_id, pattern_signature, narrative_template)
        VALUES ($1, $2, $3)
        """,
        detector_id,
        signature,
        template,
    )
    logger.info(
        "incident_extractor_inserted",
        detector_id=detector_id,
        alert_id=alert_id,
    )
    return True
