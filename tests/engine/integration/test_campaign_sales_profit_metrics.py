from decimal import Decimal

import asyncpg
import pytest

from calderyn_engine.db import with_shop_context


SHOP_A = "91000000-0000-0000-0000-000000000001"
SHOP_B = "91000000-0000-0000-0000-000000000002"
CAMPAIGN_A = "92000000-0000-0000-0000-000000000001"
CAMPAIGN_BOUNDARIES = "92000000-0000-0000-0000-000000000002"
CAMPAIGN_CATALOG = "92000000-0000-0000-0000-000000000003"
CAMPAIGN_MISSING = "92000000-0000-0000-0000-000000000004"
CAMPAIGN_B = "92000000-0000-0000-0000-000000000005"
SKU_SNAPSHOT = "93000000-0000-0000-0000-000000000001"
SKU_QB = "93000000-0000-0000-0000-000000000002"
SKU_CATALOG = "93000000-0000-0000-0000-000000000003"
SKU_MISSING = "93000000-0000-0000-0000-000000000004"


async def _insert_campaign(conn, campaign_id, shop_id, name):
    await conn.execute(
        """
        insert into public.ad_campaign_dim
          (id, shop_id, platform, external_id, name, status, daily_budget_cents)
        values ($1, $2, 'meta', $3, $4, 'active', 5000)
        """,
        campaign_id,
        shop_id,
        f"ext-{campaign_id}",
        name,
    )


async def _insert_order(
    conn,
    *,
    order_id,
    campaign_id,
    sku_id,
    day_offset,
    attributed_revenue_cents,
    ship_cost_cents,
    unit_cost_cents_snapshot=None,
    refund_cents=0,
):
    await conn.execute(
        """
        insert into public.order_fact
          (id, shop_id, external_id, order_number, created_at_source,
           total_cents, subtotal_cents, financial_status, source_version,
           ship_cost_cents)
        values ($1, $2, $3, $4, current_date + $5::integer,
                $6, $6, 'paid', $7, $8)
        """,
        order_id,
        SHOP_A,
        f"ext-{order_id}",
        f"order-{order_id}",
        day_offset,
        attributed_revenue_cents,
        abs(day_offset) + 1,
        ship_cost_cents,
    )
    await conn.execute(
        """
        insert into public.order_line_fact
          (shop_id, order_id, sku_id, external_line_id, quantity, price_cents,
           total_cents, unit_cost_cents_snapshot)
        values ($1, $2, $3, $4, 1, $5, $5, $6)
        """,
        SHOP_A,
        order_id,
        sku_id,
        f"line-{order_id}",
        attributed_revenue_cents,
        unit_cost_cents_snapshot,
    )
    await conn.execute(
        """
        insert into public.attribution_fact
          (shop_id, order_id, campaign_id, platform, attributed_revenue_cents,
           attribution_method)
        values ($1, $2, $3, 'meta', $4, 'utm_exact')
        """,
        SHOP_A,
        order_id,
        campaign_id,
        attributed_revenue_cents,
    )
    if refund_cents:
        await conn.execute(
            """
            insert into public.refund_fact
              (shop_id, order_id, sku_id, external_id, external_line_id,
               quantity, subtotal_cents, processed_at, source_version)
            values ($1, $2, $3, $4, $5, 1, $6, current_date, $7)
            """,
            SHOP_A,
            order_id,
            sku_id,
            f"refund-{order_id}",
            f"refund-line-{order_id}",
            refund_cents,
            abs(day_offset) + 100,
        )


async def _seed_performance(conn):
    for sku_id, title in (
        (SKU_SNAPSHOT, "Snapshot SKU"),
        (SKU_QB, "QuickBooks SKU"),
        (SKU_CATALOG, "Catalog SKU"),
        (SKU_MISSING, "Missing SKU"),
    ):
        await conn.execute(
            """
            insert into public.sku_dim
              (id, shop_id, external_id, product_id, sku, title)
            values ($1, $2, $3, $3, $3, $4)
            """,
            sku_id,
            SHOP_A,
            f"ext-{sku_id}",
            title,
        )

    await _insert_campaign(conn, CAMPAIGN_A, SHOP_A, "BFCM Revenue")
    await _insert_campaign(conn, CAMPAIGN_BOUNDARIES, SHOP_A, "Always On")
    await _insert_campaign(conn, CAMPAIGN_CATALOG, SHOP_A, "Catalog Sale")
    await _insert_campaign(conn, CAMPAIGN_MISSING, SHOP_A, "Missing Costs")
    await _insert_campaign(conn, CAMPAIGN_B, SHOP_B, "Other Shop Sale")

    await conn.execute(
        """
        insert into public.cogs_fact
          (shop_id, sku_id, unit_cost_cents, effective_from, source)
        values
          ($1, $2, 250, current_date - interval '1 year', 'shopify_cost'),
          ($1, $2, 400, current_date - interval '2 years', 'quickbooks'),
          ($1, $3, 175, current_date - interval '1 year', 'shopify_cost')
        """,
        SHOP_A,
        SKU_QB,
        SKU_CATALOG,
    )

    await _insert_order(
        conn,
        order_id="94000000-0000-0000-0000-000000000001",
        campaign_id=CAMPAIGN_A,
        sku_id=SKU_SNAPSHOT,
        day_offset=0,
        attributed_revenue_cents=4500,
        ship_cost_cents=300,
        unit_cost_cents_snapshot=1000,
        refund_cents=500,
    )
    await _insert_order(
        conn,
        order_id="94000000-0000-0000-0000-000000000002",
        campaign_id=CAMPAIGN_A,
        sku_id=SKU_QB,
        day_offset=-29,
        attributed_revenue_cents=2000,
        ship_cost_cents=200,
    )
    await _insert_order(
        conn,
        order_id="94000000-0000-0000-0000-000000000003",
        campaign_id=CAMPAIGN_CATALOG,
        sku_id=SKU_CATALOG,
        day_offset=0,
        attributed_revenue_cents=1000,
        ship_cost_cents=100,
    )
    await _insert_order(
        conn,
        order_id="94000000-0000-0000-0000-000000000004",
        campaign_id=CAMPAIGN_MISSING,
        sku_id=SKU_MISSING,
        day_offset=0,
        attributed_revenue_cents=1000,
        ship_cost_cents=None,
    )

    await conn.executemany(
        """
        insert into public.ad_spend_fact
          (shop_id, campaign_id, day, spend_cents)
        values ($1, $2, current_date + $3::integer, $4)
        """,
        [
            (SHOP_A, CAMPAIGN_A, 0, 1000),
            (SHOP_A, CAMPAIGN_A, -29, 1000),
            (SHOP_A, CAMPAIGN_CATALOG, 0, 100),
            (SHOP_A, CAMPAIGN_BOUNDARIES, -6, 6),
            (SHOP_A, CAMPAIGN_BOUNDARIES, -7, 7),
            (SHOP_A, CAMPAIGN_BOUNDARIES, -29, 29),
            (SHOP_A, CAMPAIGN_BOUNDARIES, -30, 30),
            (SHOP_A, CAMPAIGN_BOUNDARIES, -89, 89),
            (SHOP_A, CAMPAIGN_BOUNDARIES, -90, 90),
            (SHOP_B, CAMPAIGN_B, 0, 9999),
        ],
    )


@pytest.mark.asyncio
async def test_detector_precedence_and_insert_trigger(pg_pool, seed_shop):
    await seed_shop(SHOP_A)
    async with pg_pool.acquire() as conn:
        labels = await conn.fetchval(
            """
            select array[
              detect_campaign_sale_type('Cyber Monday BFCM'),
              detect_campaign_sale_type('BFCM holiday sale'),
              detect_campaign_sale_type('Holiday seasonal sale'),
              detect_campaign_sale_type('Seasonal sale'),
              detect_campaign_sale_type('General sale'),
              detect_campaign_sale_type('Always on awareness')
            ]
            """
        )
        assert labels == [
            "Cyber Monday",
            "Black Friday",
            "Holiday",
            "Seasonal",
            "General Sale",
            None,
        ]

        campaign_id = "92000000-0000-0000-0000-000000000101"
        await _insert_campaign(conn, campaign_id, SHOP_A, "BFCM Launch")
        row = await conn.fetchrow(
            """
            select campaign_kind, sale_type, classification_source
              from public.ad_campaign_dim where id = $1
            """,
            campaign_id,
        )
        assert tuple(row) == ("sales", "Black Friday", "detected")


@pytest.mark.asyncio
async def test_merchant_classification_survives_sync_upsert(pg_pool, seed_shop):
    await seed_shop(SHOP_A)
    campaign_id = "92000000-0000-0000-0000-000000000102"
    async with pg_pool.acquire() as conn:
        await conn.execute(
            """
            insert into public.ad_campaign_dim
              (id, shop_id, platform, external_id, name, status,
               campaign_kind, sale_type, classification_source)
            values ($1, $2, 'meta', 'merchant-override', 'Always On', 'active',
                    'sales', 'Anniversary', 'merchant')
            """,
            campaign_id,
            SHOP_A,
        )
        await conn.execute(
            """
            insert into public.ad_campaign_dim
              (shop_id, platform, external_id, name, status)
            values ($1, 'meta', 'merchant-override', 'Synced Name', 'paused')
            on conflict (shop_id, platform, external_id) do update
              set name = excluded.name, status = excluded.status
            """,
            SHOP_A,
        )
        row = await conn.fetchrow(
            """
            select name, campaign_kind, sale_type, classification_source
              from public.ad_campaign_dim where id = $1
            """,
            campaign_id,
        )
        assert tuple(row) == ("Synced Name", "sales", "Anniversary", "merchant")


@pytest.mark.asyncio
async def test_campaign_performance_scopes_tenant_and_calculates_profit(pg_pool, seed_shop):
    await seed_shop(SHOP_A)
    await seed_shop(SHOP_B)
    async with pg_pool.acquire() as conn:
        await _seed_performance(conn)
        async with with_shop_context(conn, SHOP_A):
            rows = await conn.fetch("select * from campaign_performance(30)")
            window_spend = {}
            for window in (7, 30, 90):
                window_rows = await conn.fetch("select * from campaign_performance($1)", window)
                window_spend[window] = next(
                    row["spend_cents"]
                    for row in window_rows
                    if str(row["id"]) == CAMPAIGN_BOUNDARIES
                )

    by_id = {str(row["id"]): row for row in rows}
    assert CAMPAIGN_B not in by_id
    assert by_id[CAMPAIGN_A]["orders"] == 2
    assert by_id[CAMPAIGN_A]["revenue_cents"] == 6000
    assert by_id[CAMPAIGN_A]["spend_cents"] == 2000
    assert by_id[CAMPAIGN_A]["profit_cents"] == 1851
    assert by_id[CAMPAIGN_A]["true_roas"] == Decimal("3.0000")
    assert by_id[CAMPAIGN_A]["cost_complete"] is True
    assert set(by_id[CAMPAIGN_A]["cost_sources"]) == {"snapshot", "quickbooks"}
    assert by_id[CAMPAIGN_CATALOG]["cost_sources"] == ["catalog"]
    assert by_id[CAMPAIGN_MISSING]["cost_complete"] is False
    assert by_id[CAMPAIGN_MISSING]["profit_cents"] is None
    assert by_id[CAMPAIGN_MISSING]["true_roas"] is None
    assert window_spend == {7: 6, 30: 42, 90: 161}


@pytest.mark.asyncio
async def test_campaign_performance_rejects_unsupported_window(pg_pool, seed_shop):
    await seed_shop(SHOP_A)
    async with pg_pool.acquire() as conn:
        async with with_shop_context(conn, SHOP_A):
            with pytest.raises(asyncpg.InvalidParameterValueError, match="unsupported campaign window: 14"):
                await conn.fetch("select * from campaign_performance(14)")
