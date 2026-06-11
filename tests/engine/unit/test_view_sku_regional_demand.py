"""Contract tests for the v_sku_regional_demand view (inventory page demand column)."""
from __future__ import annotations

from decimal import Decimal

import pytest

SHOP = "00000000-0000-0000-0000-0000000000d4"
SKU_ID = "dddddddd-dddd-dddd-dddd-dddddddd1111"
OTHER_LOC = "dddddddd-dddd-dddd-dddd-dddddddd3333"


async def _fetch_row(pg_pool, shop_id: str):
    async with pg_pool.acquire() as conn:
        return await conn.fetchrow(
            "SELECT * FROM public.v_sku_regional_demand WHERE shop_id = $1 AND sku_id = $2",
            shop_id,
            SKU_ID,
        )


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
