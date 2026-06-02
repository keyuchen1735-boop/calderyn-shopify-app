# apps/engine/tests/unit/test_schemas.py
"""Plan 03 Task 4: schemas enforce the Claude contract."""
from __future__ import annotations

from decimal import Decimal

import pytest

from calderyn_engine.schemas import ClaudeOutput, ClaudeRankedItem, DetectionResult


def test_detection_result_rounds_dollar_impact():
    d = DetectionResult(
        detector_id="sku_stockout_vs_spend",
        entity_ref={"sku_id": "abc"},
        severity="high",
        dollar_impact=Decimal("123.456"),
        evidence={"spend": 1000},
    )
    assert d.dollar_impact == Decimal("123.46")


def test_claude_output_rejects_narrative_with_dollar_sign():
    with pytest.raises(ValueError):
        ClaudeOutput(
            ranked=[
                ClaudeRankedItem(
                    detector_id="x",
                    entity_ref={},
                    rank=1,
                    narrative="You lost $500 today",
                )
            ]
        )


def test_claude_output_rejects_action_phrase():
    with pytest.raises(ValueError):
        ClaudeOutput(
            ranked=[
                ClaudeRankedItem(
                    detector_id="x",
                    entity_ref={},
                    rank=1,
                    narrative="Pause this campaign immediately.",
                )
            ]
        )


def test_claude_output_truncation_limit():
    with pytest.raises(ValueError):
        ClaudeOutput(
            ranked=[
                ClaudeRankedItem(
                    detector_id="x",
                    entity_ref={},
                    rank=1,
                    narrative="x" * 281,
                )
            ]
        )
