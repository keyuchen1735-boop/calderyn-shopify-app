"""Plan 05 Task 20 — coverage of ``purge_shop_contributions``.

Two cases (testcontainer pg fixture):

  1. Purge removes only the target shop's event_log rows and leaves
     other shops untouched.
  2. After purge, the peer-baseline ETL is re-fired for every
     affected (detector, segment) pair.
"""

from __future__ import annotations

import json
import uuid
from decimal import Decimal

import pytest

from calderyn_engine.moat.consent_purge import purge_shop_contributions
from calderyn_engine.moat.peer_baselines import compute_peer_baselines
from calderyn_engine.moat.pseudonym import pseudonym_for

PEPPER = "pepper-test-task-20"
DETECTOR = "sku_stockout_vs_spend"
SEGMENT = "cat:electronics"


async def _seed(conn, shop_id: str, *, consent: bool, impacts: list[Decimal]) -> str:
    suffix = shop_id.replace("-", "")[-12:]
    await conn.execute(
        "INSERT INTO public.shops (id, shop_domain, peer_data_consent) "
        "VALUES ($1::uuid, $2, $3) "
        "ON CONFLICT (id) DO UPDATE SET peer_data_consent = EXCLUDED.peer_data_consent",
        shop_id,
        f"cp-{suffix}.myshopify.com",
        consent,
    )
    pseudonym = pseudonym_for(shop_id, PEPPER)
    await conn.execute(
        "INSERT INTO moat_keys.shop_pseudonym (shop_id, pseudonym_id) "
        "VALUES ($1::uuid, $2) ON CONFLICT (shop_id) DO NOTHING",
        shop_id,
        pseudonym,
    )
    for impact in impacts:
        await conn.execute(
            "INSERT INTO moat.event_log "
            "(pseudonym_id, event_kind, detector_id, payload) "
            "VALUES ($1, 'detection_fired', $2, $3::jsonb)",
            pseudonym,
            DETECTOR,
            json.dumps({"dollar_impact": float(impact)}),
        )
    return pseudonym


async def _cleanup(conn) -> None:
    await conn.execute("DELETE FROM moat.peer_baselines WHERE detector_id = $1", DETECTOR)
    await conn.execute("DELETE FROM moat.event_log WHERE detector_id = $1", DETECTOR)


@pytest.mark.asyncio
async def test_purge_removes_only_target_shop(pg_pool) -> None:
    async with pg_pool.acquire() as conn:
        await _cleanup(conn)
        target_id = str(uuid.uuid4())
        keep_id = str(uuid.uuid4())
        target_pseudonym = await _seed(
            conn, target_id, consent=True, impacts=[Decimal("100")] * 5
        )
        keep_pseudonym = await _seed(
            conn, keep_id, consent=True, impacts=[Decimal("200")] * 5
        )

        deleted = await purge_shop_contributions(conn, target_pseudonym)
        assert deleted == 5

        target_remaining = await conn.fetchval(
            "SELECT count(*) FROM moat.event_log WHERE pseudonym_id = $1",
            target_pseudonym,
        )
        keep_remaining = await conn.fetchval(
            "SELECT count(*) FROM moat.event_log WHERE pseudonym_id = $1",
            keep_pseudonym,
        )
        assert target_remaining == 0
        assert keep_remaining == 5


@pytest.mark.asyncio
async def test_purge_reruns_etl(pg_pool) -> None:
    async with pg_pool.acquire() as conn:
        await _cleanup(conn)
        # Six consenting shops → baseline computes successfully.
        shops = [str(uuid.uuid4()) for _ in range(6)]
        pseudonyms = []
        for sid in shops:
            pseudonyms.append(
                await _seed(conn, sid, consent=True, impacts=[Decimal("100")])
            )

        # Build the baseline first so the purge has something to re-run.
        n_initial = await compute_peer_baselines(conn, DETECTOR, SEGMENT)
        assert n_initial == 6

        # Purge one shop → ETL must re-fire and the new n is 5.
        await purge_shop_contributions(conn, pseudonyms[0])

        row = await conn.fetchrow(
            "SELECT n FROM moat.peer_baselines "
            "WHERE detector_id = $1 AND segment = $2",
            DETECTOR,
            SEGMENT,
        )
        assert row is not None
        assert int(row["n"]) == 5
