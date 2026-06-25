"""Baseline (catalog/inventory) detectors get specific, deterministic
narratives and never call Claude — they are "simple" findings whose
explanation is pure math/text.
"""
import asyncio
from decimal import Decimal
from types import SimpleNamespace

from calderyn_engine.claude_layer import rank_and_narrate
from calderyn_engine.schemas import DetectionResult

CFG = SimpleNamespace(claude_model="claude-test", anthropic_api_key="unused")


def _det(detector_id, evidence=None, impact="0"):
    return DetectionResult(
        detector_id=detector_id,
        entity_ref={"sku_id": "x", "sku": "S"},
        severity="low",
        dollar_impact=Decimal(impact),
        evidence=evidence or {},
    )


class _CountingMessages:
    def __init__(self):
        self.calls = 0

    async def create(self, **kwargs):
        self.calls += 1
        raise RuntimeError("Claude must not be called for a template-only batch")


class _CountingClient:
    def __init__(self):
        self.messages = _CountingMessages()


def test_template_only_batch_skips_claude_and_uses_specific_narratives():
    client = _CountingClient()
    dets = [
        _det("out_of_stock_live"),
        _det("inventory_untracked"),
        _det("priced_below_cost", impact="4.20"),
        _det("thin_margin"),
        _det("missing_cost", {"count": "26", "total": "26"}),
    ]
    out = asyncio.run(rank_and_narrate(dets, CFG, client=client))

    # Claude was never invoked — these are deterministic templates.
    assert client.messages.calls == 0
    assert len(out.ranked) == 5
    narr = {i.detector_id: i.narrative for i in out.ranked}
    # No generic placeholder survives for any baseline detector.
    for det_id, text in narr.items():
        assert "may deserve review" not in text, det_id
        assert text.strip()
    # missing_cost interpolates the count from evidence.
    assert "26" in narr["missing_cost"]


def test_mixed_batch_still_uses_claude():
    # A batch containing a non-baseline (complex) detector is NOT short-circuited.
    client = _CountingClient()
    dets = [_det("out_of_stock_live"), _det("margin_erosion", impact="100")]
    # Claude raises (counting client) -> falls back, but it WAS attempted.
    asyncio.run(rank_and_narrate(dets, CFG, client=client))
    assert client.messages.calls == 1
