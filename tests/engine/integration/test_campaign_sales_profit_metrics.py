from decimal import Decimal
from pathlib import Path

import asyncpg
import pytest

from calderyn_engine.db import with_shop_context


SHOP_A = "91000000-0000-0000-0000-000000000001"
SHOP_B = "91000000-0000-0000-0000-000000000002"
CAMPAIGN_A = "92000000-0000-0000-0000-000000000001"
CAMPAIGN_BOUNDARIES = "92000000-0000-0000-0000-000000000002"
CAMPAIGN_CATALOG = "92000000-0000-0000-0000-000000000003"
CAMPAIGN_MISSING_COGS = "92000000-0000-0000-0000-000000000004"
CAMPAIGN_B = "92000000-0000-0000-0000-000000000005"
CAMPAIGN_MISSING_CARRIER = "92000000-0000-0000-0000-000000000006"
CAMPAIGN_FALLBACK_CARRIER = "92000000-0000-0000-0000-000000000007"
SHOP_TIMEZONE = "91000000-0000-0000-0000-000000000003"
CAMPAIGN_TIMEZONE = "92000000-0000-0000-0000-000000000008"
SKU_TIMEZONE = "93000000-0000-0000-0000-000000000005"
SKU_SNAPSHOT = "93000000-0000-0000-0000-000000000001"
SKU_QB = "93000000-0000-0000-0000-000000000002"
SKU_CATALOG = "93000000-0000-0000-0000-000000000003"
SKU_MISSING = "93000000-0000-0000-0000-000000000004"
ANCHOR_OFFSET = -120


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
        values ($1, $2, $3, $4, current_date + $5::integer + interval '12 hours',
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


async def _ensure_transaction_ledger(conn):
    # Engine tests intentionally carry only warehouse migrations; production's
    # native-payment ledger is a dashboard prerequisite for this reporting RPC.
    await conn.execute(
        """
        create table if not exists public.transaction_ledger (
          id uuid primary key default gen_random_uuid(),
          shop_id uuid not null,
          order_ref text,
          kind text not null,
          amount_cents bigint not null
        )
        """
    )


async def _seed_performance(conn):
    await _ensure_transaction_ledger(conn)
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
    await _insert_campaign(conn, CAMPAIGN_MISSING_COGS, SHOP_A, "Missing COGS")
    await _insert_campaign(conn, CAMPAIGN_MISSING_CARRIER, SHOP_A, "Missing Carrier")
    await _insert_campaign(conn, CAMPAIGN_FALLBACK_CARRIER, SHOP_A, "Fallback Carrier")
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
        day_offset=ANCHOR_OFFSET,
        attributed_revenue_cents=4500,
        ship_cost_cents=300,
        unit_cost_cents_snapshot=1000,
        refund_cents=500,
    )
    await conn.executemany(
        """
        insert into public.transaction_ledger (shop_id, order_ref, kind, amount_cents)
        values ($1, $2, 'capture', $3)
        """,
        [
            (SHOP_A, "order-94000000-0000-0000-0000-000000000001", 2500),
            (SHOP_A, "order-94000000-0000-0000-0000-000000000001", 2000),
        ],
    )
    await conn.execute(
        """
        insert into public.order_line_fact
          (shop_id, order_id, sku_id, external_line_id, quantity, price_cents,
           total_cents, unit_cost_cents_snapshot)
        values ($1, $2, $3, 'fanout-line', 1, 0, 0, 250)
        """,
        SHOP_A,
        "94000000-0000-0000-0000-000000000001",
        SKU_SNAPSHOT,
    )
    await _insert_order(
        conn,
        order_id="94000000-0000-0000-0000-000000000002",
        campaign_id=CAMPAIGN_A,
        sku_id=SKU_QB,
        day_offset=ANCHOR_OFFSET - 29,
        attributed_revenue_cents=5000,
        ship_cost_cents=200,
    )
    await conn.execute(
        """
        update public.order_fact
           set total_cents = 5000, subtotal_cents = 5000,
               financial_status = 'partially_paid'
         where id = '94000000-0000-0000-0000-000000000002'
        """
    )
    await conn.execute(
        """
        insert into public.transaction_ledger (shop_id, order_ref, kind, amount_cents)
        values ($1, 'order-94000000-0000-0000-0000-000000000002', 'capture', 2000)
        """,
        SHOP_A,
    )
    await _insert_order(
        conn,
        order_id="94000000-0000-0000-0000-000000000003",
        campaign_id=CAMPAIGN_CATALOG,
        sku_id=SKU_CATALOG,
        day_offset=ANCHOR_OFFSET,
        attributed_revenue_cents=1000,
        ship_cost_cents=100,
    )
    await _insert_order(
        conn,
        order_id="94000000-0000-0000-0000-000000000004",
        campaign_id=CAMPAIGN_MISSING_COGS,
        sku_id=SKU_MISSING,
        day_offset=ANCHOR_OFFSET,
        attributed_revenue_cents=1000,
        ship_cost_cents=100,
    )
    await _insert_order(
        conn,
        order_id="94000000-0000-0000-0000-000000000005",
        campaign_id=CAMPAIGN_MISSING_CARRIER,
        sku_id=SKU_CATALOG,
        day_offset=ANCHOR_OFFSET,
        attributed_revenue_cents=1000,
        ship_cost_cents=None,
    )
    await _insert_order(
        conn,
        order_id="94000000-0000-0000-0000-000000000007",
        campaign_id=CAMPAIGN_FALLBACK_CARRIER,
        sku_id=SKU_CATALOG,
        day_offset=ANCHOR_OFFSET,
        attributed_revenue_cents=1000,
        ship_cost_cents=0,
    )
    await conn.execute(
        """
        update public.order_fact
           set ship_cost_source = 'fallback'
         where id = '94000000-0000-0000-0000-000000000007'
        """
    )
    await conn.execute(
        """
        update public.order_fact
           set ship_cost_source = 'fallback', ship_cost_manual_cents = 100
         where id = '94000000-0000-0000-0000-000000000003'
        """
    )
    await conn.execute(
        """
        insert into public.order_fact
          (id, shop_id, external_id, order_number, created_at_source,
           total_cents, subtotal_cents, financial_status, source_version,
           ship_cost_cents)
        values ('94000000-0000-0000-0000-000000000008', $1, 'unattributed',
                'unattributed', current_date + $2::integer + interval '12 hours',
                99000, 99000, 'paid', 999, 100)
        """,
        SHOP_A,
        ANCHOR_OFFSET,
    )
    await _insert_order(
        conn,
        order_id="94000000-0000-0000-0000-000000000006",
        campaign_id=CAMPAIGN_A,
        sku_id=SKU_SNAPSHOT,
        day_offset=ANCHOR_OFFSET - 30,
        attributed_revenue_cents=900,
        ship_cost_cents=100,
        unit_cost_cents_snapshot=100,
    )

    await conn.executemany(
        """
        insert into public.ad_spend_fact
          (shop_id, campaign_id, day, spend_cents)
        values ($1, $2, current_date + $3::integer, $4)
        """,
        [
            (SHOP_A, CAMPAIGN_A, ANCHOR_OFFSET, 1000),
            (SHOP_A, CAMPAIGN_A, ANCHOR_OFFSET - 29, 1000),
            (SHOP_A, CAMPAIGN_CATALOG, ANCHOR_OFFSET, 100),
            (SHOP_A, CAMPAIGN_BOUNDARIES, ANCHOR_OFFSET - 6, 6),
            (SHOP_A, CAMPAIGN_BOUNDARIES, ANCHOR_OFFSET - 7, 7),
            (SHOP_A, CAMPAIGN_BOUNDARIES, ANCHOR_OFFSET - 29, 29),
            (SHOP_A, CAMPAIGN_BOUNDARIES, ANCHOR_OFFSET - 30, 30),
            (SHOP_A, CAMPAIGN_BOUNDARIES, ANCHOR_OFFSET - 89, 89),
            (SHOP_A, CAMPAIGN_BOUNDARIES, ANCHOR_OFFSET - 90, 90),
            (SHOP_B, CAMPAIGN_B, ANCHOR_OFFSET, 9999),
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
              detect_campaign_sale_type('Spring sale'),
              detect_campaign_sale_type('Back to School'),
              detect_campaign_sale_type('Spring Awareness'),
              detect_campaign_sale_type('Waterfall'),
              detect_campaign_sale_type('General sale'),
              detect_campaign_sale_type('Always on awareness'),
              detect_campaign_sale_type('CyberMonday'),
              detect_campaign_sale_type('Holidayish'),
              detect_campaign_sale_type('Xmas sale'),
              detect_campaign_sale_type('New Year launch')
            ]
            """
        )
        assert labels == [
            "Cyber Monday",
            "Black Friday",
            "Holiday",
            "Seasonal",
            "Seasonal",
            None,
            None,
            "General Sale",
            None,
            None,
            None,
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
        explicit_rows = await conn.fetch(
            "select * from campaign_performance($1::integer, $2::uuid)", 30, SHOP_A
        )
        await conn.execute(
            "update public.guardrail_config set timezone = 'America/Los_Angeles' where shop_id = $1",
            SHOP_A,
        )
        await conn.execute(
            """
            update public.order_fact
               set created_at_source = (current_date + $1::integer + 1)::timestamp + interval '1 hour'
             where id = '94000000-0000-0000-0000-000000000006'
            """,
            ANCHOR_OFFSET,
        )
        async with with_shop_context(conn, SHOP_A):
            timezone_row = await conn.fetchrow(
                "select * from campaign_performance(30) where id = $1", CAMPAIGN_A
            )

    by_id = {str(row["id"]): row for row in rows}
    assert CAMPAIGN_B not in by_id
    assert by_id[CAMPAIGN_A]["orders"] == 2
    assert by_id[CAMPAIGN_A]["revenue_cents"] == 6000
    assert by_id[CAMPAIGN_A]["spend_cents"] == 2000
    assert by_id[CAMPAIGN_A]["profit_cents"] == 1571
    assert by_id[CAMPAIGN_A]["true_roas"] == Decimal("3.0000")
    assert by_id[CAMPAIGN_A]["cost_complete"] is True
    assert set(by_id[CAMPAIGN_A]["cost_sources"]) == {"snapshot", "quickbooks"}
    assert by_id[CAMPAIGN_CATALOG]["cost_sources"] == ["catalog"]
    assert by_id[CAMPAIGN_CATALOG]["cost_complete"] is True
    assert by_id[CAMPAIGN_MISSING_COGS]["cost_complete"] is False
    assert "missing:cogs" in by_id[CAMPAIGN_MISSING_COGS]["cost_sources"]
    assert by_id[CAMPAIGN_MISSING_COGS]["profit_cents"] == 841
    assert by_id[CAMPAIGN_MISSING_COGS]["true_roas"] is None
    assert by_id[CAMPAIGN_MISSING_CARRIER]["cost_complete"] is False
    assert "missing:carrier" in by_id[CAMPAIGN_MISSING_CARRIER]["cost_sources"]
    assert by_id[CAMPAIGN_MISSING_CARRIER]["profit_cents"] == 766
    assert by_id[CAMPAIGN_FALLBACK_CARRIER]["cost_complete"] is False
    assert "missing:carrier" in by_id[CAMPAIGN_FALLBACK_CARRIER]["cost_sources"]
    assert by_id[CAMPAIGN_FALLBACK_CARRIER]["profit_cents"] == 766
    assert window_spend == {7: 6, 30: 42, 90: 161}
    assert CAMPAIGN_A in {str(row["id"]) for row in explicit_rows}
    assert CAMPAIGN_B not in {str(row["id"]) for row in explicit_rows}
    assert timezone_row["orders"] == 3


@pytest.mark.asyncio
async def test_campaign_performance_has_targeted_shop_join_indexes(pg_pool):
    async with pg_pool.acquire() as conn:
        definitions = await conn.fetchval(
            """
            select array_agg(indexdef order by indexdef)
              from pg_indexes
             where schemaname = 'public'
               and tablename in ('ad_spend_fact', 'order_line_fact', 'refund_fact')
               and (indexdef like '%(shop_id, day%'
                 or indexdef like '%(shop_id, order_id)%')
            """
        )
        function_definition = await conn.fetchval(
            "select pg_get_functiondef('public.campaign_performance(integer, uuid)'::regprocedure)"
        )

    assert len(definitions) == 3
    assert "o.created_at_source >= b.start_at" in function_definition
    assert "o.created_at_source < b.end_at" in function_definition
    assert "(o.created_at_source at time zone" not in function_definition


@pytest.mark.asyncio
async def test_no_spend_window_uses_the_configured_reporting_timezone(pg_pool, seed_shop):
    await seed_shop(SHOP_TIMEZONE)
    async with pg_pool.acquire() as conn:
        await _ensure_transaction_ledger(conn)
        timezone = await conn.fetchval(
            """
            select case
              when (current_timestamp at time zone 'Pacific/Kiritimati')::date <> current_date
                then 'Pacific/Kiritimati'
              else 'America/Adak'
            end
            """
        )
        assert await conn.fetchval(
            "select (current_timestamp at time zone $1)::date <> current_date", timezone
        )
        await conn.execute(
            "update public.guardrail_config set timezone = $2 where shop_id = $1",
            SHOP_TIMEZONE,
            timezone,
        )
        await conn.execute(
            """
            insert into public.sku_dim (id, shop_id, external_id, product_id, sku, title)
            values ($1, $2, 'tz-sku', 'tz-product', 'tz-sku', 'Timezone SKU')
            """,
            SKU_TIMEZONE,
            SHOP_TIMEZONE,
        )
        await _insert_campaign(conn, CAMPAIGN_TIMEZONE, SHOP_TIMEZONE, "Timezone Sale")
        for suffix, local_day_offset, amount in (("1", -6, 1000), ("2", -7, 9000)):
            order_id = f"94000000-0000-0000-0000-00000000010{suffix}"
            await conn.execute(
                """
                insert into public.order_fact
                  (id, shop_id, external_id, order_number, created_at_source,
                   total_cents, subtotal_cents, financial_status, source_version,
                   ship_cost_cents)
                values ($1, $2, $3, $3,
                        (((current_timestamp at time zone $4)::date + $5::integer + time '12:00')
                          at time zone $4),
                        $6, $6, 'paid', $7, 100)
                """,
                order_id,
                SHOP_TIMEZONE,
                f"tz-order-{suffix}",
                timezone,
                local_day_offset,
                amount,
                int(suffix),
            )
            await conn.execute(
                """
                insert into public.order_line_fact
                  (shop_id, order_id, sku_id, external_line_id, quantity, price_cents,
                   total_cents, unit_cost_cents_snapshot)
                values ($1, $2, $3, $4, 1, $5, $5, 100)
                """,
                SHOP_TIMEZONE,
                order_id,
                SKU_TIMEZONE,
                f"tz-line-{suffix}",
                amount,
            )
            await conn.execute(
                """
                insert into public.attribution_fact
                  (shop_id, order_id, campaign_id, platform, attributed_revenue_cents,
                   attribution_method)
                values ($1, $2, $3, 'meta', $4, 'utm_exact')
                """,
                SHOP_TIMEZONE,
                order_id,
                CAMPAIGN_TIMEZONE,
                amount,
            )
        async with with_shop_context(conn, SHOP_TIMEZONE):
            row = await conn.fetchrow(
                "select * from campaign_performance(7) where id = $1", CAMPAIGN_TIMEZONE
            )

    assert row["orders"] == 1
    assert row["revenue_cents"] == 1000


@pytest.mark.asyncio
async def test_campaign_classification_migration_backfills_existing_rows(pg_pool, seed_shop):
    await seed_shop(SHOP_A)
    campaign_id = "92000000-0000-0000-0000-000000000109"
    async with pg_pool.acquire() as conn:
        await conn.execute("alter table public.ad_campaign_dim disable trigger user")
        try:
            await _insert_campaign(conn, campaign_id, SHOP_A, "BFCM Existing")
        finally:
            await conn.execute("alter table public.ad_campaign_dim enable trigger user")
        migration = (
            Path(__file__).parents[3]
            / "supabase/migrations/20260719190000_campaign_sales_profit_metrics.sql"
        ).read_text()
        await conn.execute(migration)
        row = await conn.fetchrow(
            """
            select campaign_kind, sale_type, classification_source
              from public.ad_campaign_dim
             where id = $1
            """,
            campaign_id,
        )

    assert tuple(row) == ("sales", "Black Friday", "detected")


@pytest.mark.asyncio
async def test_campaign_performance_rejects_context_shop_mismatch(pg_pool, seed_shop):
    await seed_shop(SHOP_A)
    await seed_shop(SHOP_B)
    async with pg_pool.acquire() as conn:
        async with with_shop_context(conn, SHOP_A):
            await conn.execute("set local role authenticated")
            with pytest.raises(asyncpg.InsufficientPrivilegeError, match="campaign shop context mismatch"):
                await conn.fetch(
                    "select * from campaign_performance($1::integer, $2::uuid)", 30, SHOP_B
                )


@pytest.mark.asyncio
async def test_campaign_performance_rejects_missing_context(pg_pool, seed_shop):
    await seed_shop(SHOP_A)
    async with pg_pool.acquire() as conn:
        tx = conn.transaction()
        await tx.start()
        try:
            await conn.execute("set local role authenticated")
            with pytest.raises(asyncpg.InsufficientPrivilegeError, match="campaign shop context required"):
                await conn.fetch("select * from campaign_performance(30)")
        finally:
            await tx.rollback()


@pytest.mark.parametrize(
    ("window", "message"),
    [(14, "unsupported campaign window: 14"), (None, "unsupported campaign window: <NULL>")],
)
@pytest.mark.asyncio
async def test_campaign_performance_rejects_unsupported_window(
    pg_pool, seed_shop, window, message
):
    await seed_shop(SHOP_A)
    async with pg_pool.acquire() as conn:
        async with with_shop_context(conn, SHOP_A):
            with pytest.raises(asyncpg.InvalidParameterValueError, match=message):
                await conn.fetch("select * from campaign_performance($1::integer)", window)
