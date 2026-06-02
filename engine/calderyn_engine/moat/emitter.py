"""Plan 05 Task 6 — Python-side moat event emitter.

Mirrors ``packages/shared/src/moat/emitter.ts`` 1:1: same validation
order, same consent-gate rule, same fallback when the pseudonym row
is missing. Used by ``calderyn_engine.pipeline`` (Task 7) and by the
Phase B trainer when it lands.

Pipeline:
    1. Validate ``kind`` against EVENT_KINDS (raise on unknown).
    2. Validate ``payload`` via PAYLOAD_MODELS[kind].model_validate.
    3. Resolve the pseudonym for shop_id under the active pepper.
       Looks up moat_keys.shop_pseudonym first; if missing, inserts
       the mapping ON CONFLICT DO NOTHING and uses the computed value.
    4. Gate on consent: events in ALWAYS_EMIT_KINDS always flow;
       others are suppressed when peer_data_consent is False.
    5. Insert one row into moat.event_log.

Returns True if a row was written, False if the consent gate
suppressed the emit. Raises on validation errors so the caller can
surface them — emit failures are loud, not silent.
"""
from __future__ import annotations

import json
from typing import Any

import structlog

from .events import (
    ALWAYS_EMIT_KINDS,
    EVENT_KINDS,
    PAYLOAD_MODELS,
)
from .pseudonym import pseudonym_for

logger = structlog.get_logger()


async def emit_moat_event(
    conn: Any,
    *,
    shop_id: str,
    kind: str,
    payload: dict[str, Any],
    pepper: str,
    peer_data_consent: bool,
    detector_id: str | None = None,
) -> bool:
    """Append one row to ``moat.event_log`` (or skip on consent).

    Parameters
    ----------
    conn:
        An asyncpg connection (or any object exposing ``fetchrow`` /
        ``fetchval`` / ``execute``). The caller is responsible for
        transaction scope — this function does not BEGIN/COMMIT.
    shop_id:
        Tenant uuid (string form).
    kind:
        Event kind enum value. Must be in :data:`EVENT_KINDS`.
    payload:
        Per-kind payload dict. Validated via the matching pydantic
        model in :data:`PAYLOAD_MODELS`.
    pepper:
        Active pepper string for HMAC.
    peer_data_consent:
        Merchant's current consent flag. Gated kinds skip when False.
    detector_id:
        Optional detector id (only set for detector-scoped events).

    Returns
    -------
    bool
        True if a row was written, False if consent suppressed the emit.
    """

    if kind not in EVENT_KINDS:
        raise ValueError(f"emit_moat_event: unknown kind {kind!r}")

    model_cls = PAYLOAD_MODELS[kind]
    # Validates and coerces — e.g. UUID strings → uuid.UUID, ints into
    # the right slots. mode="json" on the dump emits JSON-serialisable
    # primitives so asyncpg's jsonb codec is happy.
    parsed = model_cls.model_validate(payload)

    if kind not in ALWAYS_EMIT_KINDS and not peer_data_consent:
        logger.debug(
            "moat_emit_skipped_consent",
            shop_id=shop_id,
            kind=kind,
            detector_id=detector_id,
        )
        return False

    pseudonym_id = await _resolve_pseudonym(conn, shop_id, pepper)

    payload_json = json.dumps(parsed.model_dump(mode="json"))

    await conn.execute(
        "insert into moat.event_log "
        "(pseudonym_id, event_kind, detector_id, payload) "
        "values ($1, $2, $3, $4::jsonb)",
        pseudonym_id,
        kind,
        detector_id,
        payload_json,
    )
    return True


async def _resolve_pseudonym(conn: Any, shop_id: str, pepper: str) -> str:
    """Look up moat_keys.shop_pseudonym; insert a row if missing.

    Idempotent under contention: HMAC is deterministic so two
    concurrent emitters that miss the row both compute the same
    pseudonym. ``ON CONFLICT (shop_id) DO NOTHING`` collapses the
    race; the second caller falls back to the just-computed value.

    Plan 05 Task 22 has landed: ``app_pseudonymizer`` is now the
    ONLY role with INSERT on moat_keys.shop_pseudonym. Production
    callers MUST route this single call through a connection scoped
    to that role; an ``app_engine`` connection will fail with
    "permission denied for table shop_pseudonym" on the first emit
    for a new shop. CLAUDE.md invariant #5 forbids extending
    app_engine's grants to cover moat_keys; the workaround is a
    separate pseudonymizer pool the caller passes in via ``conn``.
    Tests run as the testcontainer superuser, which keeps unit-
    level coverage alive without weakening the prod boundary.
    """

    row = await conn.fetchrow(
        "select pseudonym_id from moat_keys.shop_pseudonym "
        "where shop_id = $1::uuid",
        shop_id,
    )
    if row is not None:
        return row["pseudonym_id"]

    computed = pseudonym_for(shop_id, pepper)
    await conn.execute(
        "insert into moat_keys.shop_pseudonym (shop_id, pseudonym_id) "
        "values ($1::uuid, $2) on conflict (shop_id) do nothing",
        shop_id,
        computed,
    )
    return computed
