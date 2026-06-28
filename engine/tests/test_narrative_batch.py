"""Batch-API narrative transport: build / submit / collect, with a mocked batches client.

Covers the transport in isolation (the pipeline wiring is intentionally separate). No
network and no DB, same style as the inline claude_layer unit tests (asyncio.run +
plain-class async mocks).
"""
import asyncio
import json
from decimal import Decimal
from types import SimpleNamespace

from calderyn_engine.claude_layer import SYSTEM_PROMPT, entity_key
from calderyn_engine.narrative_batch import (
    build_request,
    collect_narratives,
    custom_id_for,
    shop_from_custom_id,
    submit_narrative_batch,
)
from calderyn_engine.schemas import DetectionResult

SHOP = "11111111-1111-1111-1111-111111111111"


def _detection(detector_id="margin_erosion", entity=None):
    return DetectionResult(
        detector_id=detector_id,
        entity_ref=entity or {"sku": "ABC"},
        severity="high",
        dollar_impact=Decimal("100"),
        evidence={},
    )


class _AsyncResults:
    """Minimal async iterator standing in for the SDK's results paginator."""

    def __init__(self, items):
        self._items = list(items)

    def __aiter__(self):
        self._it = iter(self._items)
        return self

    async def __anext__(self):
        try:
            return next(self._it)
        except StopIteration:
            raise StopAsyncIteration


class _Batches:
    def __init__(self, *, batch=None, results=None, created_id="batch_x"):
        self._batch = batch
        self._results = results or []
        self._created_id = created_id
        self.created_requests = None

    async def create(self, *, requests):
        self.created_requests = requests
        return SimpleNamespace(id=self._created_id)

    async def retrieve(self, batch_id):
        return self._batch

    async def results(self, batch_id):
        return _AsyncResults(self._results)


def _client(batches):
    return SimpleNamespace(messages=SimpleNamespace(batches=batches))


def _succeeded(custom_id, payload):
    return SimpleNamespace(
        custom_id=custom_id,
        result=SimpleNamespace(
            type="succeeded",
            message=SimpleNamespace(content=[SimpleNamespace(type="text", text=payload)]),
        ),
    )


def test_custom_id_round_trip():
    cid = custom_id_for(SHOP)
    assert cid == f"narrative-{SHOP}"
    assert shop_from_custom_id(cid) == SHOP
    assert shop_from_custom_id("something-else") is None


def test_build_request_matches_inline_prompt():
    cfg = SimpleNamespace(claude_model="claude-test")
    req = build_request(SHOP, [_detection()], cfg)
    assert req["custom_id"] == custom_id_for(SHOP)
    assert req["params"]["model"] == "claude-test"
    assert req["params"]["system"] == SYSTEM_PROMPT
    assert req["params"]["max_tokens"] == 2048
    # the detection rode into the user message verbatim
    assert "margin_erosion" in req["params"]["messages"][0]["content"]


def test_submit_returns_batch_id_and_sends_one_request():
    cfg = SimpleNamespace(claude_model="claude-test")
    batches = _Batches(created_id="batch_42")
    bid = asyncio.run(submit_narrative_batch(_client(batches), SHOP, [_detection()], cfg))
    assert bid == "batch_42"
    assert len(batches.created_requests) == 1
    assert batches.created_requests[0]["custom_id"] == custom_id_for(SHOP)


def test_collect_returns_none_while_processing():
    batches = _Batches(batch=SimpleNamespace(processing_status="in_progress"))
    got = asyncio.run(collect_narratives(_client(batches), "batch_x"))
    assert got is None


def test_collect_parses_succeeded_results():
    payload = json.dumps(
        {
            "ranked": [
                {
                    "detector_id": "margin_erosion",
                    "entity_ref": {"sku": "ABC"},
                    "rank": 1,
                    "narrative": "Margin slipped below its recent baseline.",
                }
            ]
        }
    )
    batches = _Batches(
        batch=SimpleNamespace(processing_status="ended"),
        results=[_succeeded(custom_id_for(SHOP), payload)],
    )
    got = asyncio.run(collect_narratives(_client(batches), "batch_x"))
    key = ("margin_erosion", entity_key({"sku": "ABC"}))
    assert got == {key: "Margin slipped below its recent baseline."}


def test_collect_skips_failed_and_malformed_results():
    batches = _Batches(
        batch=SimpleNamespace(processing_status="ended"),
        results=[
            _succeeded(custom_id_for(SHOP), "not valid json"),
            SimpleNamespace(custom_id="other", result=SimpleNamespace(type="errored")),
        ],
    )
    got = asyncio.run(collect_narratives(_client(batches), "batch_x"))
    # Ended, but nothing usable: empty map (not None), and no exception raised.
    assert got == {}
