"""Plan 07 Task 10 — regression replay smoke test.

Runs ``run_replay`` against a mocked Anthropic client whose
``messages.create`` always returns invalid JSON. That guarantees the
deterministic fallback path fires for every fixture, which makes the
golden files reproducible inside CI without an ANTHROPIC_API_KEY.

The real nightly workflow uses the same runner against a live model
(``.github/workflows/nightly-claude-regression.yml``); the smoke test
here protects against regressions in the runner itself or in the
fallback path.
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from calderyn_engine.regression import (
    DEFAULT_FIXTURES,
    diff_against_golden,
    load_golden,
    run_replay,
)


_GOLDEN_DIR = (
    Path(__file__).resolve().parents[0] / "golden"
)


def _force_fallback_client() -> SimpleNamespace:
    """Mock client whose response cannot pass schema validation, so the
    deterministic fallback path inside ``rank_and_narrate`` is hit
    every time. ``"not json at all"`` is rejected by the JSON parser
    long before the validators see it."""
    block = SimpleNamespace(type="text", text="not json at all")
    response = SimpleNamespace(content=[block])
    messages = SimpleNamespace(create=AsyncMock(return_value=response))
    return SimpleNamespace(messages=messages)


@pytest.mark.asyncio
async def test_replay_smoke_diff_is_empty() -> None:
    """Run the full default fixture set and assert every fixture has a
    pinned golden whose structural diff is empty."""

    client = _force_fallback_client()
    results = await run_replay(client=client, golden_dir=_GOLDEN_DIR)

    assert len(results) == len(DEFAULT_FIXTURES), (
        f"expected {len(DEFAULT_FIXTURES)} results, got {len(results)}"
    )

    failing = [r for r in results if not r.diff.is_empty]
    if failing:
        report = "\n\n".join(
            f"=== {r.fixture_id} ===\n"
            + "\n".join(r.diff.differences)
            + "\nactual: "
            + json.dumps(r.output, sort_keys=True)
            for r in failing
        )
        raise AssertionError(
            "regression replay diff non-empty:\n\n" + report
        )


def test_every_fixture_has_a_golden_file() -> None:
    """Guards against drift between the fixture list and the goldens."""

    for fixture_id, _detections in DEFAULT_FIXTURES:
        golden = load_golden(fixture_id, golden_dir=_GOLDEN_DIR)
        assert golden is not None, (
            f"missing golden for fixture {fixture_id!r} — write "
            f"{fixture_id}.json under tests/regression/golden/ "
            f"after a green replay"
        )
        # Golden must still be a structural-shape JSON.
        assert "ranked" in golden, (
            f"golden {fixture_id!r} missing 'ranked' key"
        )


def test_diff_against_golden_returns_empty_on_match() -> None:
    """Direct unit-style coverage of diff_against_golden so a future
    refactor of the runner doesn't regress its diffing semantics."""

    actual = {"ranked": [{"detector_id": "x", "entity_ref": {}, "rank": 1, "narrative_chars": 50, "contains_dollar": False}]}
    golden = json.loads(json.dumps(actual))
    diff = diff_against_golden("test", actual, golden)
    assert diff.is_empty


def test_diff_against_golden_flags_dollar_leak() -> None:
    actual = {
        "ranked": [
            {
                "detector_id": "x",
                "entity_ref": {},
                "rank": 1,
                "narrative_chars": 50,
                "contains_dollar": True,
            }
        ]
    }
    golden = json.loads(json.dumps(actual))
    golden["ranked"][0]["contains_dollar"] = False
    diff = diff_against_golden("test", actual, golden)
    assert not diff.is_empty
    assert any("contains_dollar" in d for d in diff.differences)
