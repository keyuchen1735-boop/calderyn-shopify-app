"""Plan 05 Task 4 — pydantic model coverage. One happy-path case per
event kind plus one rejection case for an unknown kind. The TS side
asserts the same six happy paths against Zod in
``packages/shared/src/moat/events.test.ts`` so they stay in lockstep.
"""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from calderyn_engine.moat.events import (
    ALWAYS_EMIT_KINDS,
    ActionExecutedPayload,
    ActionUndonePayload,
    AlertFeedbackPayload,
    DetectionFiredPayload,
    EVENT_KINDS,
    OutcomeConfirmedPayload,
    PAYLOAD_MODELS,
    ThresholdUpdatePayload,
    is_event_kind,
)

ALERT = "00000000-0000-0000-0000-000000000001"
ALERT_2 = "00000000-0000-0000-0000-000000000002"


def test_detection_fired_happy_path() -> None:
    m = DetectionFiredPayload.model_validate(
        {
            "detector_id": "sku_stockout_vs_spend",
            "alert_id": ALERT,
            "severity": "high",
            "dollar_impact": 1234.56,
            "thresholds_used": {"min_spend_usd": 500, "ratio_threshold": 0.4},
        }
    )
    assert str(m.alert_id) == ALERT


def test_alert_feedback_happy_path() -> None:
    m = AlertFeedbackPayload.model_validate(
        {
            "alert_id": ALERT,
            "feedback_kind": "confirmed_loss",
            "confirmed_loss_usd": 2500,
        }
    )
    assert m.feedback_kind == "confirmed_loss"


def test_action_executed_happy_path() -> None:
    m = ActionExecutedPayload.model_validate(
        {
            "alert_id": ALERT,
            "action_kind": "pause_campaign",
            "outcome": "succeeded",
            "dollar_impact_at_exec": 100,
        }
    )
    assert m.outcome == "succeeded"


def test_action_undone_happy_path() -> None:
    m = ActionUndonePayload.model_validate(
        {"audit_id": ALERT, "undo_of": ALERT_2}
    )
    assert str(m.undo_of) == ALERT_2


def test_outcome_confirmed_happy_path() -> None:
    m = OutcomeConfirmedPayload.model_validate(
        {
            "alert_id": ALERT,
            "confirmed_loss_usd": 999.99,
            "days_to_confirm": 3,
        }
    )
    assert m.days_to_confirm == 3


def test_threshold_update_happy_path() -> None:
    m = ThresholdUpdatePayload.model_validate(
        {
            "detector_id": "sku_stockout_vs_spend",
            "old_thresholds": {"min_spend_usd": 500},
            "new_thresholds": {"min_spend_usd": 600},
            "reward_signal": 0.42,
        }
    )
    assert m.reward_signal == pytest.approx(0.42)


def test_rejects_unknown_event_kind() -> None:
    assert "garbage" not in EVENT_KINDS
    assert is_event_kind("garbage") is False
    assert is_event_kind("detection_fired") is True
    assert "garbage" not in PAYLOAD_MODELS


def test_always_emit_kinds_contents() -> None:
    assert ALWAYS_EMIT_KINDS == frozenset(
        {"detection_fired", "threshold_update"}
    )


def test_detection_fired_rejects_negative_dollar_impact() -> None:
    with pytest.raises(ValidationError):
        DetectionFiredPayload.model_validate(
            {
                "detector_id": "sku_stockout_vs_spend",
                "alert_id": ALERT,
                "severity": "high",
                "dollar_impact": -1.0,
                "thresholds_used": {},
            }
        )
