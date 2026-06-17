"""Slice #3 (tracer) — DB-backed coverage of the moat threshold trainer.

Uses the pg_pool fixture (skips unless TEST_DATABASE_URL is a local DB).
Exercises the real moat.peer_baselines read and the moat.detection_models
upsert (A4 pseudonym keying + idempotent re-run), plus the loop-closure
proof: get_threshold reads back exactly what the trainer wrote.
"""
from __future__ import annotations

import json
import uuid
from decimal import Decimal

import pytest

from calderyn_engine.moat.pseudonym import pseudonym_for
from calderyn_engine.moat.threshold_trainer import (
    _fold_group,
    _read_peer_baseline,
    _upsert_model,
)
from calderyn_engine.thresholds import get_threshold

PEPPER = "pepper-trainer-db"
DETECTOR = "sku_stockout_vs_spend"
KEY = "min_spend_usd"
SEGMENT = "gmv:trainer-db"


async def _seed_baseline(conn, p25, p50, p75, n) -> None:
    await conn.execute(
        "DELETE FROM moat.peer_baselines WHERE detector_id = $1 AND segment = $2",
        DETECTOR,
        SEGMENT,
    )
    await conn.execute(
        "INSERT INTO moat.peer_baselines "
        "(detector_id, segment, p25, p50, p75, n, computed_at) "
        "VALUES ($1,$2,$3,$4,$5,$6, now())",
        DETECTOR,
        SEGMENT,
        Decimal(str(p25)),
        Decimal(str(p50)),
        Decimal(str(p75)),
        n,
    )


@pytest.mark.asyncio
async def test_read_peer_baseline_roundtrips(pg_pool) -> None:
    async with pg_pool.acquire() as conn:
        await _seed_baseline(conn, 200, 300, 400, 5)
        base = await _read_peer_baseline(conn, DETECTOR, SEGMENT)
        assert base is not None
        assert base["p25"] == Decimal("200")
        assert base["p50"] == Decimal("300")
        assert base["p75"] == Decimal("400")
        assert base["n"] == 5


@pytest.mark.asyncio
async def test_read_peer_baseline_missing_returns_none(pg_pool) -> None:
    async with pg_pool.acquire() as conn:
        await conn.execute(
            "DELETE FROM moat.peer_baselines WHERE detector_id = $1 AND segment = $2",
            DETECTOR,
            "no-such-segment",
        )
        base = await _read_peer_baseline(conn, DETECTOR, "no-such-segment")
        assert base is None


@pytest.mark.asyncio
async def test_upsert_writes_pseudonym_keyed_row(pg_pool) -> None:
    async with pg_pool.acquire() as conn:
        shop_id = str(uuid.uuid4())
        pseudonym = pseudonym_for(shop_id, PEPPER)
        await conn.execute(
            "DELETE FROM moat.detection_models "
            "WHERE detector_id = $1 AND shop_id_pseudonym = $2",
            DETECTOR,
            pseudonym,
        )
        await _upsert_model(
            conn,
            DETECTOR,
            shop_id,
            {"alpha": 2.0, "beta": 1.0, "seeded_from": "peer_baseline"},
            {KEY: 213.2},
            PEPPER,
        )
        row = await conn.fetchrow(
            "SELECT shop_id_pseudonym, threshold_json FROM moat.detection_models "
            "WHERE detector_id = $1 AND shop_id_pseudonym = $2",
            DETECTOR,
            pseudonym,
        )
        assert row is not None
        # A4 — keyed by pseudonym, never the raw shop_id.
        assert row["shop_id_pseudonym"] == pseudonym
        assert row["shop_id_pseudonym"].startswith("p_")
        tj = (
            json.loads(row["threshold_json"])
            if isinstance(row["threshold_json"], str)
            else row["threshold_json"]
        )
        assert tj[KEY] == 213.2


@pytest.mark.asyncio
async def test_upsert_is_idempotent_on_conflict(pg_pool) -> None:
    async with pg_pool.acquire() as conn:
        shop_id = str(uuid.uuid4())
        pseudonym = pseudonym_for(shop_id, PEPPER)
        await _upsert_model(
            conn, DETECTOR, shop_id, {"alpha": 2.0, "beta": 1.0}, {KEY: 213.2}, PEPPER
        )
        await _upsert_model(
            conn, DETECTOR, shop_id, {"alpha": 9.0, "beta": 1.0}, {KEY: 111.0}, PEPPER
        )
        rows = await conn.fetch(
            "SELECT threshold_json FROM moat.detection_models "
            "WHERE detector_id = $1 AND shop_id_pseudonym = $2",
            DETECTOR,
            pseudonym,
        )
        # ON CONFLICT DO UPDATE => still exactly one row, carrying the latest values.
        assert len(rows) == 1
        tj = (
            json.loads(rows[0]["threshold_json"])
            if isinstance(rows[0]["threshold_json"], str)
            else rows[0]["threshold_json"]
        )
        assert tj[KEY] == 111.0


@pytest.mark.asyncio
async def test_trained_model_is_read_back_by_get_threshold(pg_pool) -> None:
    """THE TRACER PROOF — the loop closes end-to-end on one shop.

    peer baseline (p50=300) seeds the prior -> a confirmed_loss reward
    shifts the published threshold below consensus -> the trainer upserts
    the detection_models row -> get_threshold() returns exactly that value,
    NOT the static $500 default. Consume reads what Train wrote.
    """
    async with pg_pool.acquire() as conn:
        shop_id = str(uuid.uuid4())
        pseudonym = pseudonym_for(shop_id, PEPPER)
        await conn.execute(
            "DELETE FROM moat.detection_models "
            "WHERE detector_id = $1 AND shop_id_pseudonym = $2",
            DETECTOR,
            pseudonym,
        )
        await _seed_baseline(conn, 200, 300, 400, 5)
        base = await _read_peer_baseline(conn, DETECTOR, SEGMENT)
        rows = [
            {
                "shop_id": shop_id,
                "detector_id": DETECTOR,
                "feedback_kind": "confirmed_loss",
                "dollar_impact": Decimal("50"),
                "days_to_confirm": 1,
                "alert_id": "al-000",
            }
        ]
        posterior, threshold = _fold_group(rows, base, KEY, Decimal("500"), 0.5)
        await _upsert_model(conn, DETECTOR, shop_id, posterior, threshold, PEPPER)

        learned = await get_threshold(conn, shop_id, DETECTOR, pepper=PEPPER)

        # The loop is live: a learned, peer-informed value — not the $500 default.
        assert learned == Decimal(str(threshold[KEY]))
        assert learned < Decimal("300")  # confirmed_loss loosened it below consensus
        assert learned != Decimal("500")  # NOT the static default
