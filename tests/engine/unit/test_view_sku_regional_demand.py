"""Contract tests for the v_sku_regional_demand view (inventory page demand column)."""
from __future__ import annotations

from decimal import Decimal

import pytest

SHOP = "00000000-0000-0000-0000-0000000000d4"
SKU_ID = "dddddddd-dddd-dddd-dddd-dddddddd1111"
OTHER_LOC = "dddddddd-dddd-dddd-dddd-dddddddd3333"

# --------------------------------------------------------------------------
# UUIDs for the multi-region tests (each test gets a distinct SHOP + SKU so
# there are no global-PK collisions between tests; sku_dim.id is a global PK).
# --------------------------------------------------------------------------
SHOP_TWO = "00000000-0000-0000-0000-0000000000e1"   # two-region share test
SHOP_TIE = "00000000-0000-0000-0000-0000000000e2"   # tie-break test
SHOP_FAN = "00000000-0000-0000-0000-0000000000e3"   # fan-out pin test
SHOP_SPL = "00000000-0000-0000-0000-0000000000e4"   # same-region split test

SKU_TWO = "e1eeeeee-eeee-eeee-eeee-eeeeeeee1111"   # two-region SKU (SHOP_TWO)
SKU_TIE = "e2eeeeee-eeee-eeee-eeee-eeeeeeee1111"   # tie-break SKU (SHOP_TIE)
SKU_FAN = "e3eeeeee-eeee-eeee-eeee-eeeeeeee1111"   # fan-out SKU  (SHOP_FAN)
SKU_SPL = "e4eeeeee-eeee-eeee-eeee-eeeeeeee1111"   # split SKU    (SHOP_SPL)

# Location IDs for the extra test shops (also distinct per-shop)
LOC_TWO_CA = "e1eeeeee-eeee-eeee-eeee-eeeeeeee2222"  # CA location (SHOP_TWO)
LOC_TWO_NY = "e1eeeeee-eeee-eeee-eeee-eeeeeeee3333"  # NY location (SHOP_TWO)
LOC_TIE_CA = "e2eeeeee-eeee-eeee-eeee-eeeeeeee2222"  # CA location (SHOP_TIE)
LOC_TIE_NY = "e2eeeeee-eeee-eeee-eeee-eeeeeeee3333"  # NY location (SHOP_TIE)
LOC_FAN_CA = "e3eeeeee-eeee-eeee-eeee-eeeeeeee2222"  # CA location (SHOP_FAN)
LOC_SPL_CA1 = "e4eeeeee-eeee-eeee-eeee-eeeeeeee2222"  # 1st CA location (SHOP_SPL)
LOC_SPL_CA2 = "e4eeeeee-eeee-eeee-eeee-eeeeeeee3333"  # 2nd CA location (SHOP_SPL)

ORD_TWO_CA = "e1eeeeee-eeee-eeee-eeee-eeeeeeee5555"  # CA order (SHOP_TWO)
ORD_TWO_NY = "e1eeeeee-eeee-eeee-eeee-eeeeeeee6666"  # NY order (SHOP_TWO)
ORD_TIE_CA = "e2eeeeee-eeee-eeee-eeee-eeeeeeee5555"  # CA order (SHOP_TIE)
ORD_TIE_NY = "e2eeeeee-eeee-eeee-eeee-eeeeeeee6666"  # NY order (SHOP_TIE)
ORD_FAN    = "e3eeeeee-eeee-eeee-eeee-eeeeeeee5555"  # order   (SHOP_FAN)
ORD_SPL    = "e4eeeeee-eeee-eeee-eeee-eeeeeeee5555"  # order   (SHOP_SPL)

FF_TWO_CA = "e1eeeeee-eeee-eeee-eeee-eeeeeeee7777"   # CA fulfillment (SHOP_TWO)
FF_TWO_NY = "e1eeeeee-eeee-eeee-eeee-eeeeeeee8888"   # NY fulfillment (SHOP_TWO)
FF_TIE_CA = "e2eeeeee-eeee-eeee-eeee-eeeeeeee7777"   # CA fulfillment (SHOP_TIE)
FF_TIE_NY = "e2eeeeee-eeee-eeee-eeee-eeeeeeee8888"   # NY fulfillment (SHOP_TIE)
FF_FAN_1  = "e3eeeeee-eeee-eeee-eeee-eeeeeeee7777"   # 1st fulfillment (SHOP_FAN)
FF_FAN_2  = "e3eeeeee-eeee-eeee-eeee-eeeeeeee8888"   # 2nd fulfillment (SHOP_FAN, fan-out)
FF_SPL_1  = "e4eeeeee-eeee-eeee-eeee-eeeeeeee7777"   # 1st fulfillment (SHOP_SPL, CA loc 1)
FF_SPL_2  = "e4eeeeee-eeee-eeee-eeee-eeeeeeee8888"   # 2nd fulfillment (SHOP_SPL, CA loc 2)


async def _fetch_row(pg_pool, shop_id: str, sku_id: str = SKU_ID):
    async with pg_pool.acquire() as conn:
        return await conn.fetchrow(
            "SELECT * FROM public.v_sku_regional_demand WHERE shop_id = $1 AND sku_id = $2",
            shop_id,
            sku_id,
        )


# --------------------------------------------------------------------------
# Cleanup helper for the extra-shop tests
# --------------------------------------------------------------------------
async def _cleanup_extra(conn, shop_id: str) -> None:
    """Delete all rows keyed to one of our extra test shops."""
    await conn.execute("DELETE FROM public.fulfillment_fact WHERE shop_id = $1", shop_id)
    await conn.execute("DELETE FROM public.order_line_fact WHERE shop_id = $1", shop_id)
    await conn.execute("DELETE FROM public.order_fact WHERE shop_id = $1", shop_id)
    await conn.execute("DELETE FROM public.inventory_level_fact WHERE shop_id = $1", shop_id)
    await conn.execute("DELETE FROM public.location_dim WHERE shop_id = $1", shop_id)
    await conn.execute("DELETE FROM public.sku_dim WHERE shop_id = $1", shop_id)
    await conn.execute("DELETE FROM public.shops WHERE id = $1", shop_id)


@pytest.mark.asyncio
async def test_top_region_and_stock(pg_pool, seed_shop, seed_regional_shortage_scenario) -> None:
    await seed_shop(SHOP)
    # 300 units fulfilled from CA in 30 days => daily_demand 10, all demand in CA.
    await seed_regional_shortage_scenario(
        SHOP, region="CA", regional_stock=50, units_30d=300, unit_margin_usd=Decimal("20")
    )
    row = await _fetch_row(pg_pool, SHOP)
    assert row is not None
    assert row["main_demand_region"] == "CA"
    assert row["demand_units_30d"] == 300
    assert row["stock_in_region"] == 50
    assert float(row["demand_share"]) == pytest.approx(1.0)
    # Destination: the active CA location. No stock outside CA => no source.
    assert row["dest_location_external_id"] == "loc-rs-region"
    assert row["src_location_external_id"] is None


@pytest.mark.asyncio
async def test_source_is_largest_holder_outside_region(
    pg_pool, seed_shop, seed_regional_shortage_scenario
) -> None:
    await seed_shop(SHOP)
    await seed_regional_shortage_scenario(
        SHOP, region="CA", regional_stock=5, units_30d=300, unit_margin_usd=Decimal("20")
    )
    async with pg_pool.acquire() as conn:
        # Park 80 units at the NY location and give the SKU an inventory item GID.
        await conn.execute(
            """
            INSERT INTO public.inventory_level_fact
              (shop_id, sku_id, location_id, available, observed_at, source_version)
            VALUES ($1, $2, $3, 80, now(), 999999)
            """,
            SHOP,
            SKU_ID,
            OTHER_LOC,
        )
        await conn.execute(
            "UPDATE public.sku_dim SET inventory_item_id = 'gid://shopify/InventoryItem/9' WHERE id = $1",
            SKU_ID,
        )
    row = await _fetch_row(pg_pool, SHOP)
    assert row["src_location_external_id"] == "loc-rs-other"
    assert row["src_available"] == 80
    assert row["inventory_item_id"] == "gid://shopify/InventoryItem/9"
    detail = row["locations_detail"]
    assert detail is not None  # jsonb array with both locations, available desc
    import json
    parsed = json.loads(detail) if isinstance(detail, str) else detail
    assert all("active" in loc for loc in parsed)  # relocate dialog filters destinations on it


# --------------------------------------------------------------------------
# New contract tests (code-review findings)
# --------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_two_region_share_and_top_pick(pg_pool, seed_shop) -> None:
    """300 CA units + 100 NY units => main_demand_region='CA', demand_share≈0.75."""
    await seed_shop(SHOP_TWO)
    async with pg_pool.acquire() as conn:
        await _cleanup_extra(conn, SHOP_TWO)
        await conn.execute(
            "INSERT INTO public.shops (id, shop_domain) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING",
            SHOP_TWO, "test-extra-e1.myshopify.com",
        )
        await conn.execute(
            """INSERT INTO public.sku_dim
                 (id, shop_id, external_id, product_id, sku, title, unit_cost_cents, currency)
               VALUES ($1, $2, 'ext-e1-1', 'prod-e1-1', 'E1-1', 'Multi-Region SKU', 1000, 'USD')""",
            SKU_TWO, SHOP_TWO,
        )
        # CA location (active)
        await conn.execute(
            """INSERT INTO public.location_dim (id, shop_id, external_id, name, country, region, active)
               VALUES ($1, $2, 'loc-e1-ca', 'CA WH', 'US', 'CA', true)""",
            LOC_TWO_CA, SHOP_TWO,
        )
        # NY location (active)
        await conn.execute(
            """INSERT INTO public.location_dim (id, shop_id, external_id, name, country, region, active)
               VALUES ($1, $2, 'loc-e1-ny', 'NY WH', 'US', 'NY', true)""",
            LOC_TWO_NY, SHOP_TWO,
        )
        # CA order: 300 units, fulfilled from CA
        await conn.execute(
            """INSERT INTO public.order_fact
                 (id, shop_id, external_id, order_number, created_at_source,
                  total_cents, subtotal_cents, source_version)
               VALUES ($1, $2, 'ord-e1-ca', '#E1CA', now() - interval '5 days',
                       90000, 90000, 1)""",
            ORD_TWO_CA, SHOP_TWO,
        )
        await conn.execute(
            """INSERT INTO public.order_line_fact
                 (shop_id, order_id, sku_id, external_line_id,
                  quantity, price_cents, total_cents, unit_cost_cents_snapshot)
               VALUES ($1, $2, $3, 'line-e1-ca', 300, 300, 90000, 1000)""",
            SHOP_TWO, ORD_TWO_CA, SKU_TWO,
        )
        await conn.execute(
            """INSERT INTO public.fulfillment_fact
                 (id, shop_id, order_id, external_id, location_id, status, source_version)
               VALUES ($1, $2, $3, 'ff-e1-ca', $4, 'success', 1)""",
            FF_TWO_CA, SHOP_TWO, ORD_TWO_CA, LOC_TWO_CA,
        )
        # NY order: 100 units, fulfilled from NY
        await conn.execute(
            """INSERT INTO public.order_fact
                 (id, shop_id, external_id, order_number, created_at_source,
                  total_cents, subtotal_cents, source_version)
               VALUES ($1, $2, 'ord-e1-ny', '#E1NY', now() - interval '5 days',
                       30000, 30000, 2)""",
            ORD_TWO_NY, SHOP_TWO,
        )
        await conn.execute(
            """INSERT INTO public.order_line_fact
                 (shop_id, order_id, sku_id, external_line_id,
                  quantity, price_cents, total_cents, unit_cost_cents_snapshot)
               VALUES ($1, $2, $3, 'line-e1-ny', 100, 300, 30000, 1000)""",
            SHOP_TWO, ORD_TWO_NY, SKU_TWO,
        )
        await conn.execute(
            """INSERT INTO public.fulfillment_fact
                 (id, shop_id, order_id, external_id, location_id, status, source_version)
               VALUES ($1, $2, $3, 'ff-e1-ny', $4, 'success', 2)""",
            FF_TWO_NY, SHOP_TWO, ORD_TWO_NY, LOC_TWO_NY,
        )

    row = await _fetch_row(pg_pool, SHOP_TWO, SKU_TWO)
    assert row is not None, "View returned no row for SHOP_TWO"
    assert row["main_demand_region"] == "CA"
    assert row["demand_units_30d"] == 300
    assert float(row["demand_share"]) == pytest.approx(0.75, abs=1e-6)


@pytest.mark.asyncio
async def test_tie_break_alphabetically_first_region(pg_pool, seed_shop) -> None:
    """Equal demand (150 each) in CA and NY => CA wins (alphabetically first)."""
    await seed_shop(SHOP_TIE)
    async with pg_pool.acquire() as conn:
        await _cleanup_extra(conn, SHOP_TIE)
        await conn.execute(
            "INSERT INTO public.shops (id, shop_domain) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING",
            SHOP_TIE, "test-extra-e2.myshopify.com",
        )
        await conn.execute(
            """INSERT INTO public.sku_dim
                 (id, shop_id, external_id, product_id, sku, title, unit_cost_cents, currency)
               VALUES ($1, $2, 'ext-e2-1', 'prod-e2-1', 'E2-1', 'Tie SKU', 1000, 'USD')""",
            SKU_TIE, SHOP_TIE,
        )
        await conn.execute(
            """INSERT INTO public.location_dim (id, shop_id, external_id, name, country, region, active)
               VALUES ($1, $2, 'loc-e2-ca', 'CA WH', 'US', 'CA', true)""",
            LOC_TIE_CA, SHOP_TIE,
        )
        await conn.execute(
            """INSERT INTO public.location_dim (id, shop_id, external_id, name, country, region, active)
               VALUES ($1, $2, 'loc-e2-ny', 'NY WH', 'US', 'NY', true)""",
            LOC_TIE_NY, SHOP_TIE,
        )
        # CA order: 150 units
        await conn.execute(
            """INSERT INTO public.order_fact
                 (id, shop_id, external_id, order_number, created_at_source,
                  total_cents, subtotal_cents, source_version)
               VALUES ($1, $2, 'ord-e2-ca', '#E2CA', now() - interval '5 days',
                       45000, 45000, 1)""",
            ORD_TIE_CA, SHOP_TIE,
        )
        await conn.execute(
            """INSERT INTO public.order_line_fact
                 (shop_id, order_id, sku_id, external_line_id,
                  quantity, price_cents, total_cents, unit_cost_cents_snapshot)
               VALUES ($1, $2, $3, 'line-e2-ca', 150, 300, 45000, 1000)""",
            SHOP_TIE, ORD_TIE_CA, SKU_TIE,
        )
        await conn.execute(
            """INSERT INTO public.fulfillment_fact
                 (id, shop_id, order_id, external_id, location_id, status, source_version)
               VALUES ($1, $2, $3, 'ff-e2-ca', $4, 'success', 1)""",
            FF_TIE_CA, SHOP_TIE, ORD_TIE_CA, LOC_TIE_CA,
        )
        # NY order: 150 units
        await conn.execute(
            """INSERT INTO public.order_fact
                 (id, shop_id, external_id, order_number, created_at_source,
                  total_cents, subtotal_cents, source_version)
               VALUES ($1, $2, 'ord-e2-ny', '#E2NY', now() - interval '5 days',
                       45000, 45000, 2)""",
            ORD_TIE_NY, SHOP_TIE,
        )
        await conn.execute(
            """INSERT INTO public.order_line_fact
                 (shop_id, order_id, sku_id, external_line_id,
                  quantity, price_cents, total_cents, unit_cost_cents_snapshot)
               VALUES ($1, $2, $3, 'line-e2-ny', 150, 300, 45000, 1000)""",
            SHOP_TIE, ORD_TIE_NY, SKU_TIE,
        )
        await conn.execute(
            """INSERT INTO public.fulfillment_fact
                 (id, shop_id, order_id, external_id, location_id, status, source_version)
               VALUES ($1, $2, $3, 'ff-e2-ny', $4, 'success', 2)""",
            FF_TIE_NY, SHOP_TIE, ORD_TIE_NY, LOC_TIE_NY,
        )

    row = await _fetch_row(pg_pool, SHOP_TIE, SKU_TIE)
    assert row is not None, "View returned no row for SHOP_TIE"
    assert row["main_demand_region"] == "CA", (
        f"Expected CA (alphabetically first) to win tie, got {row['main_demand_region']!r}"
    )


@pytest.mark.asyncio
async def test_fan_out_pin(pg_pool, seed_shop) -> None:
    """One order (qty 300) with TWO success fulfillment rows from the SAME location
    must count as 300, not 600.  This pins fix #1 (DISTINCT dedupe in regional_demand).
    """
    await seed_shop(SHOP_FAN)
    async with pg_pool.acquire() as conn:
        await _cleanup_extra(conn, SHOP_FAN)
        await conn.execute(
            "INSERT INTO public.shops (id, shop_domain) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING",
            SHOP_FAN, "test-extra-e3.myshopify.com",
        )
        await conn.execute(
            """INSERT INTO public.sku_dim
                 (id, shop_id, external_id, product_id, sku, title, unit_cost_cents, currency)
               VALUES ($1, $2, 'ext-e3-1', 'prod-e3-1', 'E3-1', 'Fan-Out SKU', 1000, 'USD')""",
            SKU_FAN, SHOP_FAN,
        )
        await conn.execute(
            """INSERT INTO public.location_dim (id, shop_id, external_id, name, country, region, active)
               VALUES ($1, $2, 'loc-e3-ca', 'CA WH', 'US', 'CA', true)""",
            LOC_FAN_CA, SHOP_FAN,
        )
        # Single order, 300 units
        await conn.execute(
            """INSERT INTO public.order_fact
                 (id, shop_id, external_id, order_number, created_at_source,
                  total_cents, subtotal_cents, source_version)
               VALUES ($1, $2, 'ord-e3-1', '#E3-1', now() - interval '5 days',
                       90000, 90000, 1)""",
            ORD_FAN, SHOP_FAN,
        )
        await conn.execute(
            """INSERT INTO public.order_line_fact
                 (shop_id, order_id, sku_id, external_line_id,
                  quantity, price_cents, total_cents, unit_cost_cents_snapshot)
               VALUES ($1, $2, $3, 'line-e3-1', 300, 300, 90000, 1000)""",
            SHOP_FAN, ORD_FAN, SKU_FAN,
        )
        # TWO fulfillment rows for the SAME order from the SAME CA location
        await conn.execute(
            """INSERT INTO public.fulfillment_fact
                 (id, shop_id, order_id, external_id, location_id, status, source_version)
               VALUES ($1, $2, $3, 'ff-e3-1', $4, 'success', 1)""",
            FF_FAN_1, SHOP_FAN, ORD_FAN, LOC_FAN_CA,
        )
        await conn.execute(
            """INSERT INTO public.fulfillment_fact
                 (id, shop_id, order_id, external_id, location_id, status, source_version)
               VALUES ($1, $2, $3, 'ff-e3-2', $4, 'success', 2)""",
            FF_FAN_2, SHOP_FAN, ORD_FAN, LOC_FAN_CA,
        )

    row = await _fetch_row(pg_pool, SHOP_FAN, SKU_FAN)
    assert row is not None, "View returned no row for SHOP_FAN"
    assert row["demand_units_30d"] == 300, (
        f"Fan-out bug: expected 300 but got {row['demand_units_30d']} "
        "(two fulfillment rows for same order+location doubled the count)"
    )


@pytest.mark.asyncio
async def test_same_region_split_fulfillment_counts_once(pg_pool, seed_shop) -> None:
    """One order (qty 300) fulfilled from TWO DIFFERENT locations in the SAME
    region must count as 300, not 600.  Demand attribution is once per order
    per REGION, not per location.
    """
    await seed_shop(SHOP_SPL)
    async with pg_pool.acquire() as conn:
        await _cleanup_extra(conn, SHOP_SPL)
        await conn.execute(
            "INSERT INTO public.shops (id, shop_domain) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING",
            SHOP_SPL, "test-extra-e4.myshopify.com",
        )
        await conn.execute(
            """INSERT INTO public.sku_dim
                 (id, shop_id, external_id, product_id, sku, title, unit_cost_cents, currency)
               VALUES ($1, $2, 'ext-e4-1', 'prod-e4-1', 'E4-1', 'Split SKU', 1000, 'USD')""",
            SKU_SPL, SHOP_SPL,
        )
        # TWO locations, both in CA
        await conn.execute(
            """INSERT INTO public.location_dim (id, shop_id, external_id, name, country, region, active)
               VALUES ($1, $2, 'loc-e4-ca1', 'CA WH 1', 'US', 'CA', true)""",
            LOC_SPL_CA1, SHOP_SPL,
        )
        await conn.execute(
            """INSERT INTO public.location_dim (id, shop_id, external_id, name, country, region, active)
               VALUES ($1, $2, 'loc-e4-ca2', 'CA WH 2', 'US', 'CA', true)""",
            LOC_SPL_CA2, SHOP_SPL,
        )
        # Single order, 300 units
        await conn.execute(
            """INSERT INTO public.order_fact
                 (id, shop_id, external_id, order_number, created_at_source,
                  total_cents, subtotal_cents, source_version)
               VALUES ($1, $2, 'ord-e4-1', '#E4-1', now() - interval '5 days',
                       90000, 90000, 1)""",
            ORD_SPL, SHOP_SPL,
        )
        await conn.execute(
            """INSERT INTO public.order_line_fact
                 (shop_id, order_id, sku_id, external_line_id,
                  quantity, price_cents, total_cents, unit_cost_cents_snapshot)
               VALUES ($1, $2, $3, 'line-e4-1', 300, 300, 90000, 1000)""",
            SHOP_SPL, ORD_SPL, SKU_SPL,
        )
        # TWO success fulfillment rows for the SAME order from DIFFERENT CA locations
        await conn.execute(
            """INSERT INTO public.fulfillment_fact
                 (id, shop_id, order_id, external_id, location_id, status, source_version)
               VALUES ($1, $2, $3, 'ff-e4-1', $4, 'success', 1)""",
            FF_SPL_1, SHOP_SPL, ORD_SPL, LOC_SPL_CA1,
        )
        await conn.execute(
            """INSERT INTO public.fulfillment_fact
                 (id, shop_id, order_id, external_id, location_id, status, source_version)
               VALUES ($1, $2, $3, 'ff-e4-2', $4, 'success', 2)""",
            FF_SPL_2, SHOP_SPL, ORD_SPL, LOC_SPL_CA2,
        )

    row = await _fetch_row(pg_pool, SHOP_SPL, SKU_SPL)
    assert row is not None, "View returned no row for SHOP_SPL"
    assert row["demand_units_30d"] == 300, (
        f"Same-region split bug: expected 300 but got {row['demand_units_30d']} "
        "(an order fulfilled from two locations in the same region was counted twice)"
    )
