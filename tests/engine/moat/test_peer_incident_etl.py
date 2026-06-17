"""Slice #5 — peer + incident ETL tests. DB-backed tests use the parent
pg_pool fixture and skip unless TEST_DATABASE_URL points at a local pg."""

from __future__ import annotations

import json
import uuid
from datetime import date
from decimal import Decimal

import pytest

from calderyn_engine.moat.peer_incident_etl import segment_for_shop
from calderyn_engine.moat.pseudonym import pseudonym_for

PEPPER = "pepper-test-slice5"
DETECTOR = "ad_tax_overload"


def test_segment_for_shop_band_thresholds():
    assert segment_for_shop(0) == "gmv:micro"
    assert segment_for_shop(9_999_99) == "gmv:micro"          # $9,999.99
    assert segment_for_shop(10_000_00) == "gmv:small"         # $10,000.00
    assert segment_for_shop(49_999_99) == "gmv:small"
    assert segment_for_shop(50_000_00) == "gmv:mid"
    assert segment_for_shop(249_999_99) == "gmv:mid"
    assert segment_for_shop(250_000_00) == "gmv:large"
    assert segment_for_shop(999_999_99) == "gmv:large"
    assert segment_for_shop(1_000_000_00) == "gmv:xl"
    assert segment_for_shop(5_000_000_00) == "gmv:xl"


# ---------------------------------------------------------------------------
# Shared seed helpers (mirror tests/engine/moat/test_peer_baselines.py style).
# ---------------------------------------------------------------------------


async def _seed_shop(conn, shop_id: str, *, consent: bool) -> None:
    suffix = shop_id.replace("-", "")[-12:]
    await conn.execute(
        "INSERT INTO public.shops (id, shop_domain, peer_data_consent) "
        "VALUES ($1::uuid, $2, $3) "
        "ON CONFLICT (id) DO UPDATE SET peer_data_consent = EXCLUDED.peer_data_consent",
        shop_id, f"pie-{suffix}.myshopify.com", consent,
    )


async def _seed_order(conn, shop_id: str, *, total_cents: int, days_ago: int) -> None:
    await conn.execute(
        """
        INSERT INTO public.order_fact
          (id, shop_id, external_id, order_number, created_at_source,
           total_cents, subtotal_cents, source_version)
        VALUES (gen_random_uuid(), $1::uuid, $2, $3,
                now() - ($4::int * interval '1 day'), $5, $5,
                (extract(epoch from clock_timestamp())*1000)::bigint)
        """,
        shop_id, f"ord-{uuid.uuid4().hex[:8]}", f"#{uuid.uuid4().hex[:6]}",
        days_ago, total_cents,
    )


@pytest.mark.asyncio
async def test_gmv_band_for_shop_sums_trailing_90d(pg_pool):
    from calderyn_engine.moat.peer_incident_etl import gmv_band_for_shop
    async with pg_pool.acquire() as conn:
        shop_id = str(uuid.uuid4())
        await _seed_shop(conn, shop_id, consent=True)
        # $30,000 inside the window -> small; one stale order outside it ignored.
        await _seed_order(conn, shop_id, total_cents=30_000_00, days_ago=10)
        await _seed_order(conn, shop_id, total_cents=999_999_00, days_ago=200)
        band = await gmv_band_for_shop(conn, shop_id, date.today())
        assert band == "gmv:small"


@pytest.mark.asyncio
async def test_gmv_band_zero_orders_is_micro(pg_pool):
    from calderyn_engine.moat.peer_incident_etl import gmv_band_for_shop
    async with pg_pool.acquire() as conn:
        shop_id = str(uuid.uuid4())
        await _seed_shop(conn, shop_id, consent=True)
        band = await gmv_band_for_shop(conn, shop_id, date.today())
        assert band == "gmv:micro"
