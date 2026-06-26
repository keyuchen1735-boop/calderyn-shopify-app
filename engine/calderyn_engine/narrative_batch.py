"""Async Batch API transport for engine narratives (dormant until ENGINE_BATCH_NARRATIVES=1).

The detect cron is non-latency-sensitive, so narratives for genuinely-new complex
findings can be produced through the Message Batches API at 50% of standard token
cost instead of an inline call. This module is just the transport — build a batch
request from a detection batch, submit it, and collect completed narratives.

Wiring it into the pipeline (submit on new findings; collect on a later run; persist
the upgraded narrative) is deliberately kept separate: it ships dormant, is unit-
testable with a mocked batches client, and the Config flag keeps it off until the
``claude_rank_call`` telemetry shows the volume justifies the async machinery.

Output parity with the inline path: the request reuses ``claude_layer.SYSTEM_PROMPT``
and its user-message builder, and results parse through the same ``ClaudeOutput``
schema, so a batch narrative is validated exactly like an inline one.
"""
from __future__ import annotations

from typing import Any

import structlog

# Reuse the inline path's prompt builders verbatim so a batched narrative is the same
# request as an inline one (same system, same user message) — narratives must not
# drift depending on which path produced them.
from calderyn_engine.claude_layer import (
    SYSTEM_PROMPT,
    _build_user_message,
    entity_key,
)
from calderyn_engine.config import Config
from calderyn_engine.schemas import ClaudeOutput, DetectionResult

logger = structlog.get_logger()

# custom_id routes a result back to its shop without any server-side state. The
# Batches API only requires custom_ids unique WITHIN a batch; we submit one request
# per batch, so a per-shop id is safe. (Anthropic caps custom_id at 64 chars;
# "narrative-" + a 36-char uuid shop_id fits.)
_CUSTOM_ID_PREFIX = "narrative"


def custom_id_for(shop_id: str) -> str:
    return f"{_CUSTOM_ID_PREFIX}-{shop_id}"


def shop_from_custom_id(custom_id: str) -> str | None:
    prefix = f"{_CUSTOM_ID_PREFIX}-"
    return custom_id[len(prefix) :] if custom_id.startswith(prefix) else None


def build_request(
    shop_id: str, detections: list[DetectionResult], cfg: Config
) -> dict[str, Any]:
    """One Batches API request for a shop's detection batch."""
    return {
        "custom_id": custom_id_for(shop_id),
        "params": {
            "model": cfg.claude_model,
            "system": SYSTEM_PROMPT,
            "messages": [
                {"role": "user", "content": _build_user_message(detections)}
            ],
            "max_tokens": 2048,
        },
    }


async def submit_narrative_batch(
    client: Any, shop_id: str, detections: list[DetectionResult], cfg: Config
) -> str | None:
    """Submit a batch for a shop's new-finding narratives; return the batch id.

    Returns None if the client handed back no id — the caller treats that as a no-op
    (the inline deterministic fallback already covered this run's alerts).
    """
    batch = await client.messages.batches.create(
        requests=[build_request(shop_id, detections, cfg)]
    )
    batch_id = _get(batch, "id")
    logger.info(
        "narrative_batch_submitted",
        shop_id=shop_id,
        batch_id=batch_id,
        detections=len(detections),
    )
    return batch_id


async def collect_narratives(
    client: Any, batch_id: str
) -> dict[tuple[str, str], str] | None:
    """Parse an ended batch's narratives, keyed by ``(detector_id, entity_key)``.

    Returns ``None`` while the batch is still processing, or a (possibly empty) map
    once it has ended. A failed or malformed result is skipped and logged, never
    raised — the inline deterministic fallback is the source of truth for anything
    we don't get here (rule 12: a bad result is surfaced in logs, not crashed on).
    """
    batch = await client.messages.batches.retrieve(batch_id)
    if _get(batch, "processing_status") != "ended":
        return None

    out: dict[tuple[str, str], str] = {}
    results = await client.messages.batches.results(batch_id)
    async for result in results:
        if _get(_get(result, "result"), "type") != "succeeded":
            continue
        text = _result_text(result)
        if not text:
            continue
        try:
            parsed = ClaudeOutput.model_validate_json(text)
        except Exception as exc:  # noqa: BLE001 — one bad result must not drop the rest
            logger.warning(
                "narrative_batch_parse_skip",
                batch_id=batch_id,
                custom_id=_get(result, "custom_id"),
                reason=type(exc).__name__,
            )
            continue
        for item in parsed.ranked:
            out[(item.detector_id, entity_key(item.entity_ref))] = item.narrative
    logger.info("narrative_batch_collected", batch_id=batch_id, narratives=len(out))
    return out


def _get(obj: Any, key: str) -> Any:
    """Read ``key`` from an SDK object or a plain dict (tests and the SDK differ)."""
    if obj is None:
        return None
    val = getattr(obj, key, None)
    if val is None and isinstance(obj, dict):
        val = obj.get(key)
    return val


def _result_text(result: Any) -> str | None:
    """Concatenate the text blocks of a succeeded batch result's message."""
    message = _get(_get(result, "result"), "message")
    content = _get(message, "content")
    if not content:
        return None
    parts: list[str] = []
    for block in content:
        if _get(block, "type") != "text":
            continue
        text = _get(block, "text")
        if isinstance(text, str):
            parts.append(text)
    return "".join(parts) if parts else None
