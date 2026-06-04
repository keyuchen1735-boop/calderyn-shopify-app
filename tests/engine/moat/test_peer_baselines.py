"""Plan 05 Task 16 — integration coverage of ``compute_peer_baselines``.

These tests use the real testcontainer pg fixture (``pg_pool``) so we
exercise the actual SQL aggregates. We seed:

  * 2 consenting shops + 5 detection_fired events each → k-floor
    breach → no row written.
  * 5 consenting shops + 5 detection_fired events each → row
    written, n == 5, p25/p50/p75 match the expected quartiles.
  * Mixed consent: 5 consenting + 2 non-consenting → only the 5
    contribute; non-consenting shops are silently filtered.
"""

from __future__ import annotations

import json
import uuid
from decimal import Decimal

import pytest

from calderyn_engine.moat.peer_baselines import compute_peer_baselines
from calderyn_engine.moat.pseudonym import pseudonym_for

PEPPER = "pepper-test-task-16"
DETECTOR = "sku_stockout_vs_spend"
SEGMENT = "cat:electronics"


async def _seed_shop_with_events(
    conn,
    shop_id: str,
    *,
    consent: bool,
    impacts: list[Decimal],
) -> str:
    """Insert a shop, its pseudonym, and N detection_fired events.

    Returns the pseudonym for assertions.
    """
    suffix = shop_id.replace("-", "")[-12:]
    await conn.execute(
        "INSERT INTO public.shops (id, shop_domain, peer_data_consent) "
        "VALUES ($1::uuid, $2, $3) "
        "ON CONFLICT (id) DO UPDATE SET peer_data_consent = EXCLUDED.peer_data_consent",
        shop_id,
        f"pb-{suffix}.myshopify.com",
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
    # moat_keys + shops cleanup happens implicitly per-test via
    # uniquely-generated UUIDs; we don't blow the table away to avoid
    # interfering with other tests in the same session.


@pytest.mark.asyncio
async def test_k_floor_breach_writes_no_row(pg_pool) -> None:
    """2 shops < k_floor=5 → compute returns 0 and no peer_baselines row."""
    async with pg_pool.acquire() as conn:
        await _cleanup(conn)
        shops = [str(uuid.uuid4()) for _ in range(2)]
        for sid in shops:
            await _seed_shop_with_events(
                conn, sid, consent=True, impacts=[Decimal("100")] * 3
            )

        n = await compute_peer_baselines(conn, DETECTOR, SEGMENT)
        assert n == 0
        rows = await conn.fetch(
            "SELECT * FROM moat.peer_baselines "
            "WHERE detector_id = $1 AND segment = $2",
            DETECTOR,
            SEGMENT,
        )
        assert rows == []


@pytest.mark.asyncio
async def test_5_consenting_shops_writes_row_with_quartiles(pg_pool) -> None:
    """5 consenting shops with one event each at $100/$200/$300/$400/$500 →
    p25=200, p50=300, p75=400, n=5.
    """
    async with pg_pool.acquire() as conn:
        await _cleanup(conn)
        impacts = [Decimal("100"), Decimal("200"), Decimal("300"),
                   Decimal("400"), Decimal("500")]
        for impact in impacts:
            sid = str(uuid.uuid4())
            await _seed_shop_with_events(
                conn, sid, consent=True, impacts=[impact]
            )

        n = await compute_peer_baselines(conn, DETECTOR, SEGMENT)
        assert n == 5

        row = await conn.fetchrow(
            "SELECT p25, p50, p75, n FROM moat.peer_baselines "
            "WHERE detector_id = $1 AND segment = $2",
            DETECTOR,
            SEGMENT,
        )
        assert row is not None
        assert int(row["n"]) == 5
        # percentile_cont gives interpolated quartiles on this set.
        assert Decimal(row["p25"]) == Decimal("200")
        assert Decimal(row["p50"]) == Decimal("300")
        assert Decimal(row["p75"]) == Decimal("400")


@pytest.mark.asyncio
async def test_non_consenting_shops_are_dropped(pg_pool) -> None:
    """5 consenting + 2 non-consenting shops → only the 5 contribute, n=5."""
    async with pg_pool.acquire() as conn:
        await _cleanup(conn)
        for _ in range(5):
            sid = str(uuid.uuid4())
            await _seed_shop_with_events(
                conn, sid, consent=True, impacts=[Decimal("100")]
            )
        # These two should be filtered out.
        for _ in range(2):
            sid = str(uuid.uuid4())
            await _seed_shop_with_events(
                conn, sid, consent=False, impacts=[Decimal("9999")]
            )

        n = await compute_peer_baselines(conn, DETECTOR, SEGMENT)
        assert n == 5

        row = await conn.fetchrow(
            "SELECT n, p50 FROM moat.peer_baselines "
            "WHERE detector_id = $1 AND segment = $2",
            DETECTOR,
            SEGMENT,
        )
        assert int(row["n"]) == 5
        # All consenting shops contributed $100 → p50 must be 100, not
        # the $9999 from the non-consenting outliers.
        assert Decimal(row["p50"]) == Decimal("100")
