# apps/engine/calderyn_engine/schemas.py
"""Pydantic v2 schemas for the engine.

Plan 03 Task 4: locks the Claude contract — narrative ranking only, no
dollar amounts, no action verbs, ≤ 280 chars. ``DetectionResult`` is frozen
and rounds ``dollar_impact`` to two decimal places via banker-friendly
ROUND_HALF_UP so estimator outputs are byte-identical between runs.
"""
from __future__ import annotations

import re
from decimal import Decimal, ROUND_HALF_UP
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

Severity = Literal["low", "medium", "high", "critical"]
AlertStatus = Literal["open", "acknowledged", "resolved", "snoozed", "dismissed"]

_DOLLAR_PAT = re.compile(r"\$\s?\d")
_ACTION_PAT = re.compile(
    # Spec §7 action-type verbs + a few common synonyms. `create` is here to
    # block "create a purchase order" narratives that would re-introduce the
    # create_po_draft executor by name.
    r"\b(pause|resume|reduce|increase|reallocate|exclude|stop|launch|shift|move|transfer|create)\b",
    re.IGNORECASE,
)


class DetectionResult(BaseModel):
    model_config = ConfigDict(frozen=True)
    detector_id: str
    entity_ref: dict[str, Any]
    severity: Severity
    dollar_impact: Decimal
    evidence: dict[str, Any]

    @field_validator("dollar_impact")
    @classmethod
    def _round(cls, v: Decimal) -> Decimal:
        return v.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


class ClaudeRankedItem(BaseModel):
    detector_id: str
    entity_ref: dict[str, Any]
    rank: int = Field(ge=1)
    narrative: str = Field(max_length=280)

    @field_validator("narrative")
    @classmethod
    def _no_dollars_or_actions(cls, v: str) -> str:
        if _DOLLAR_PAT.search(v):
            raise ValueError("narrative must not contain dollar amounts")
        if _ACTION_PAT.search(v):
            raise ValueError("narrative must not prescribe actions")
        return v


class ClaudeOutput(BaseModel):
    ranked: list[ClaudeRankedItem]


class AlertRow(BaseModel):
    shop_id: str
    detector_id: str
    entity_ref: dict[str, Any]
    severity: Severity
    dollar_impact: Decimal
    day_bucket: str  # ISO date
    claude_narrative: str | None = None
    claude_rank: int | None = None
    evidence: dict[str, Any]
