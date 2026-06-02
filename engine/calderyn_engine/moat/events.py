"""Plan 05 Task 4 — pydantic models for every ``moat.event_kind`` payload.

Mirrors ``packages/shared/src/moat/events.ts`` 1:1. When adding a new
kind, add it here AND in ``events.ts`` AND in the ``moat.event_kind``
Postgres enum at the same time. The emitter (``./emitter.py``) selects
the right model by kind via ``PAYLOAD_MODELS[kind].model_validate(...)``
— a missing key raises ``ValueError`` at runtime, which is intentional:
an unknown kind has no payload shape so we'd rather fail loud than
silently log junk.
"""
from __future__ import annotations

from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

# Source-of-truth tuple of every legal moat event kind. Order matches
# the Postgres enum literal order (see
# supabase/migrations/20260501000030_moat_schema.sql) and the TS
# ``EventKinds`` constant.
EVENT_KINDS: tuple[str, ...] = (
    "detection_fired",
    "alert_feedback",
    "action_executed",
    "action_undone",
    "outcome_confirmed",
    "threshold_update",
)

# Events we ALWAYS emit regardless of peer_data_consent. Mirrors
# ``ALWAYS_EMIT_KINDS`` in ``events.ts`` — keep the two in lockstep.
ALWAYS_EMIT_KINDS: frozenset[str] = frozenset(
    {"detection_fired", "threshold_update"},
)


# pydantic v2: forbid extra keys so payload shape drift fails loud at
# the emitter boundary rather than silently writing unknown JSON.
class _StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class DetectionFiredPayload(_StrictModel):
    detector_id: str = Field(min_length=1)
    alert_id: UUID
    severity: Literal["low", "medium", "high", "critical"]
    dollar_impact: float = Field(ge=0)
    thresholds_used: dict[str, float | int | str]


class AlertFeedbackPayload(_StrictModel):
    alert_id: UUID
    feedback_kind: Literal["confirmed_loss", "false_positive", "already_handled"]
    confirmed_loss_usd: float | None = Field(default=None, ge=0)


class ActionExecutedPayload(_StrictModel):
    alert_id: UUID
    action_kind: str = Field(min_length=1)
    outcome: Literal["succeeded", "failed", "guardrail_blocked"]
    dollar_impact_at_exec: float = Field(ge=0)


class ActionUndonePayload(_StrictModel):
    audit_id: UUID
    undo_of: UUID


class OutcomeConfirmedPayload(_StrictModel):
    alert_id: UUID
    confirmed_loss_usd: float = Field(ge=0)
    days_to_confirm: int = Field(ge=0)


class ThresholdUpdatePayload(_StrictModel):
    detector_id: str = Field(min_length=1)
    old_thresholds: dict[str, float | int | str]
    new_thresholds: dict[str, float | int | str]
    reward_signal: float


# Lookup table the emitter uses to validate inbound payloads.
PAYLOAD_MODELS: dict[str, type[_StrictModel]] = {
    "detection_fired": DetectionFiredPayload,
    "alert_feedback": AlertFeedbackPayload,
    "action_executed": ActionExecutedPayload,
    "action_undone": ActionUndonePayload,
    "outcome_confirmed": OutcomeConfirmedPayload,
    "threshold_update": ThresholdUpdatePayload,
}


def is_event_kind(value: object) -> bool:
    """True iff ``value`` is one of :data:`EVENT_KINDS`."""

    return isinstance(value, str) and value in EVENT_KINDS
