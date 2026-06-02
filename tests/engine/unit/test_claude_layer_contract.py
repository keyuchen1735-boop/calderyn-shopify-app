"""Plan 03 Task 18: locked Claude JSON contract.

Five contract cases, all with a mocked Anthropic client (no network):

1. Happy path — clean JSON ClaudeOutput round-trips through the parser.
2. Fallback when Claude returns unparseable text.
3. Fallback when narrative contains a dollar amount.
4. Fallback when narrative contains an action verb.
5. Fallback when narrative exceeds 280 characters.

In every fallback case the deterministic template kicks in, which is
schema-valid by construction (no ``$``, no action verb, ≤ 280 chars).
"""

from __future__ import annotations

import re
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from calderyn_engine.claude_layer import rank_and_narrate
from calderyn_engine.config import Config
from calderyn_engine.schemas import DetectionResult, _ACTION_PAT, _DOLLAR_PAT


def _cfg() -> Config:
    return Config(
        database_url="postgres://test",
        anthropic_api_key="test-key",
        env="test",
        claude_model="claude-opus-4-7",
    )


def _detection() -> DetectionResult:
    return DetectionResult(
        detector_id="sku_stockout_vs_spend",
        entity_ref={"sku_id": "x1"},
        severity="high",
        dollar_impact=Decimal("500.00"),
        evidence={"spend_7d_usd": "800"},
    )


def _mock_client(text: str) -> SimpleNamespace:
    """Build a fake AsyncAnthropic surface that returns ``text``.

    The real SDK returns ``response.content[i].text`` where each block is a
    pydantic model with ``.type == "text"``. We stand in with a plain
    SimpleNamespace and an AsyncMock for ``messages.create`` so no network
    call is made.
    """
    block = SimpleNamespace(type="text", text=text)
    response = SimpleNamespace(content=[block])
    messages = SimpleNamespace(create=AsyncMock(return_value=response))
    return SimpleNamespace(messages=messages)


@pytest.mark.asyncio
async def test_happy_path_parses_clean_json() -> None:
    raw = (
        '{"ranked":[{'
        '"detector_id":"sku_stockout_vs_spend",'
        '"entity_ref":{"sku_id":"x1"},'
        '"rank":1,'
        '"narrative":"Inventory is flat while attention is high."}]}'
    )
    client = _mock_client(raw)
    out = await rank_and_narrate([_detection()], _cfg(), client=client)
    assert len(out.ranked) == 1
    assert out.ranked[0].rank == 1
    assert out.ranked[0].narrative == "Inventory is flat while attention is high."
    assert out.ranked[0].detector_id == "sku_stockout_vs_spend"
    # Mock was called exactly once with the configured model + max_tokens.
    client.messages.create.assert_awaited_once()
    kwargs = client.messages.create.await_args.kwargs
    assert kwargs["model"] == "claude-opus-4-7"
    assert kwargs["max_tokens"] == 2048
    assert kwargs["system"]  # non-empty system prompt


@pytest.mark.asyncio
async def test_fallback_on_unparseable_json() -> None:
    client = _mock_client("not json at all")
    out = await rank_and_narrate([_detection()], _cfg(), client=client)
    # Fallback gives one item, rank 1, with the per-detector template.
    assert len(out.ranked) == 1
    assert out.ranked[0].rank == 1
    # Template is the deterministic one for sku_stockout_vs_spend, which
    # passes both validators by construction.
    assert not _DOLLAR_PAT.search(out.ranked[0].narrative)
    assert not _ACTION_PAT.search(out.ranked[0].narrative)
    assert len(out.ranked[0].narrative) <= 280


@pytest.mark.asyncio
async def test_fallback_when_narrative_contains_dollar_amount() -> None:
    raw = (
        '{"ranked":[{'
        '"detector_id":"sku_stockout_vs_spend",'
        '"entity_ref":{"sku_id":"x1"},'
        '"rank":1,'
        '"narrative":"You lost $500 on this campaign."}]}'
    )
    client = _mock_client(raw)
    out = await rank_and_narrate([_detection()], _cfg(), client=client)
    # Validator on ClaudeRankedItem rejects the $-bearing narrative — we
    # land in the fallback template, which has no $ digit.
    assert "$" not in out.ranked[0].narrative
    assert not _DOLLAR_PAT.search(out.ranked[0].narrative)


@pytest.mark.asyncio
async def test_fallback_when_narrative_contains_action_verb() -> None:
    raw = (
        '{"ranked":[{'
        '"detector_id":"sku_stockout_vs_spend",'
        '"entity_ref":{"sku_id":"x1"},'
        '"rank":1,'
        '"narrative":"Pause the campaign now to stop the bleeding."}]}'
    )
    client = _mock_client(raw)
    out = await rank_and_narrate([_detection()], _cfg(), client=client)
    # Validator rejects the action verb — fallback template kicks in.
    assert not re.search(
        r"\b(pause|reduce|increase|reallocate|exclude|stop|launch|shift|move|transfer|resume|create)\b",
        out.ranked[0].narrative,
        re.IGNORECASE,
    )


@pytest.mark.asyncio
async def test_fallback_when_narrative_exceeds_280_chars() -> None:
    long_text = "alpha " * 60  # 360 chars, no $ no actions, but too long
    raw = (
        '{"ranked":[{'
        '"detector_id":"sku_stockout_vs_spend",'
        '"entity_ref":{"sku_id":"x1"},'
        '"rank":1,'
        f'"narrative":"{long_text.strip()}"}}]}}'
    )
    client = _mock_client(raw)
    out = await rank_and_narrate([_detection()], _cfg(), client=client)
    # ClaudeRankedItem.narrative has max_length=280 — pydantic rejects,
    # fallback engages, template length is well under 280.
    assert len(out.ranked[0].narrative) <= 280
