"""Narrative caching: reuse a stored narrative for an ongoing condition so
Claude is only called for genuinely NEW (complex) findings.
"""
import asyncio
from decimal import Decimal
from types import SimpleNamespace

from calderyn_engine.claude_layer import rank_and_narrate, entity_key
from calderyn_engine.schemas import DetectionResult

CFG = SimpleNamespace(claude_model="claude-test", anthropic_api_key="unused")


def _det(detector_id, ref, impact="0"):
    return DetectionResult(
        detector_id=detector_id,
        entity_ref=ref,
        severity="high",
        dollar_impact=Decimal(impact),
        evidence={},
    )


class _CountingMessages:
    def __init__(self):
        self.calls = 0

    async def create(self, **kwargs):
        self.calls += 1
        raise RuntimeError("Claude must not be called when everything is cached")


class _CountingClient:
    def __init__(self):
        self.messages = _CountingMessages()


def test_all_cached_complex_skips_claude_and_reuses_narrative():
    d = _det("margin_erosion", {"sku_id": "a", "sku": "A"}, impact="100")
    cached = {(d.detector_id, entity_key(d.entity_ref)): "Ongoing margin issue on this product."}
    client = _CountingClient()
    out = asyncio.run(rank_and_narrate([d], CFG, client=client, cached=cached))
    assert client.messages.calls == 0
    assert out.ranked[0].narrative == "Ongoing margin issue on this product."


def test_new_complex_finding_still_calls_claude():
    d = _det("margin_erosion", {"sku_id": "b", "sku": "B"}, impact="100")
    client = _CountingClient()
    # Not cached -> Claude is attempted (then falls back because the stub raises).
    asyncio.run(rank_and_narrate([d], CFG, client=client, cached={}))
    assert client.messages.calls == 1


def test_mix_of_template_and_cached_skips_claude():
    t = _det("out_of_stock_live", {"sku_id": "x", "sku": "X"})
    c = _det("margin_erosion", {"sku_id": "y", "sku": "Y"}, impact="50")
    cached = {(c.detector_id, entity_key(c.entity_ref)): "This campaign keeps losing ground."}
    client = _CountingClient()
    out = asyncio.run(rank_and_narrate([t, c], CFG, client=client, cached=cached))
    assert client.messages.calls == 0
    narr = {i.detector_id: i.narrative for i in out.ranked}
    assert narr["margin_erosion"] == "This campaign keeps losing ground."
    assert "may deserve review" not in narr["out_of_stock_live"]
