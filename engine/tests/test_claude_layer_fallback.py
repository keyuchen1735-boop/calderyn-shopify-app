"""A Claude API failure must fall back to deterministic ranking, never crash.

Regression for the prod outage where an Anthropic 400 ("credit balance too
low") propagated out of rank_and_narrate and took down the whole engine for
every shop.
"""
import asyncio
from decimal import Decimal
from types import SimpleNamespace

from calderyn_engine.claude_layer import rank_and_narrate
from calderyn_engine.schemas import DetectionResult


class _RaisingMessages:
    async def create(self, **kwargs):
        # Mimics anthropic.BadRequestError / any API-layer failure.
        raise RuntimeError("Error code: 400 - credit balance too low")


class _RaisingClient:
    messages = _RaisingMessages()


def _detection():
    return DetectionResult(
        detector_id="missing_cost",
        entity_ref={"scope": "shop"},
        severity="low",
        dollar_impact=Decimal("0"),
        evidence={"count": "26", "total": "26"},
    )


def test_api_error_falls_back_instead_of_raising():
    cfg = SimpleNamespace(claude_model="claude-test", anthropic_api_key="unused")
    out = asyncio.run(
        rank_and_narrate([_detection()], cfg, client=_RaisingClient())
    )
    # Did not raise; fallback produced a ranked item covering the detection.
    assert len(out.ranked) == 1
    assert out.ranked[0].detector_id == "missing_cost"
    assert out.ranked[0].entity_ref == {"scope": "shop"}
