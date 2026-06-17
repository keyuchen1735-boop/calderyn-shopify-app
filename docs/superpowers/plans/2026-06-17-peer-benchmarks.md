# Peer Benchmarks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a merchant how their store's four key KPIs compare to anonymized, consented, k-anonymous peers in their category niche — on both the Shopify embedded admin and the Calderyn dashboard.

**Architecture:** Reuses the Plan 05 moat machinery (pseudonymization, k≥5 floor, nightly `/api/engine/moat-train` cron, consent purge). KPIs are defined ONCE as `public` SQL views (current_date-windowed) so the Python writer and TS reader compute the identical number. The nightly ETL aggregates per-`(metric_key, segment)` quartiles into a new `moat.peer_metric_baselines` table; the TS read path reads it through a thin `public.v_peer_metric_baselines` view (the web role can only see `public`).

**Tech Stack:** Postgres (Supabase) + asyncpg (Python engine) + Supabase JS client (Remix/TS) + React + Polaris (admin) / dashboard's own primitives.

---

## Design decisions baked in (resolved during planning)

1. **KPI definition = per-KPI `public` views.** The spec's `v_sku_sales_30d` / `v_sku_returns_30d` do not exist, and a plain view can't take the moat's `run_date` param. We create four `public.v_peer_kpi_*` views windowed to `current_date` (benchmarks are point-in-time "vs current peers" — spec §9 non-goal rules out backdating). Both languages SELECT `value` from the same view → zero drift.
2. **Read path reads `moat.*` via a `public` view.** `public.v_peer_metric_baselines` (security-definer, default) exposes the k-anonymized aggregate to the Supabase/PostgREST read path. The base table stays in `moat` per spec.
3. **Niche has two encodings (documented mirror).** `category_niche_for_shop(conn, shop_id, run_date)` (Python, for the ETL, run_date-parameterized) and `public.v_peer_shop_niche` (SQL, for read-time, current_date). A parity test pins them equal for `run_date = today`.
4. **Percentiles computed in SQL** (`percentile_cont`) on both the moat baselines and any test assertions, to match the existing `moat.peer_baselines` math exactly.
5. **Privacy (A1):** the cross-tenant aggregate SQL receives only `(pseudonym, segment, value)` arrays — never raw `shop_id`. Raw `shop_id` is used transiently only to compute each shop's own value.

---

## File structure

**Create:**
- `supabase/migrations/20260617000000_peer_metric_baselines.sql` — prod: table + public view + 4 KPI views + niche view + grants.
- `tests/engine/schema/migrations/20260617000000_peer_metric_baselines.sql` — test-DB parity (same objects + backfill ship-cost columns the test schema lacks).
- `engine/calderyn_engine/moat/peer_metrics_etl.py` — `category_niche_for_shop`, `run_peer_metrics`, the aggregate.
- `tests/engine/moat/test_peer_metrics_etl.py` — pytest for niche resolver + aggregate.
- `app/lib/benchmarks/types.ts` — `PeerKpi`, `PeerBenchmarks` (shared, non-server).
- `app/lib/benchmarks/peer-benchmarks.server.ts` — `getPeerBenchmarks`.
- `app/lib/benchmarks/peer-benchmarks.server.test.ts` — vitest for the read path.
- `app/components/calderyn/PeerBenchmarksCard.tsx` — Polaris card (admin surface).
- `app/components/calderyn/__tests__/peer-benchmarks-card.test.tsx` — RTL test.
- `app/components/dashboard/screens/PeerBenchmarks.tsx` — dashboard card.
- `app/routes/dashboard.api.benchmarks.tsx` — dashboard data route.
- `app/components/dashboard/screens/__tests__/peer-benchmarks.test.ts` — dashboard card test.

**Modify:**
- `engine/calderyn_engine/moat/consent_purge.py` — call `run_peer_metrics` after detector re-aggregation (GDPR).
- `engine/_moat_train_core.py` — call `run_peer_metrics` in the nightly transaction.
- Caller(s) of `purge_shop_contributions` — pass `pepper` + `run_date` (signature change).
- `app/routes/app._index.tsx` — loader fetches benchmarks; render the Polaris card.
- `app/components/dashboard/screens/Dashboard.tsx` — render the dashboard card.

---

## Task 1: Migration — `moat.peer_metric_baselines` + read/KPI views

**Files:**
- Create: `supabase/migrations/20260617000000_peer_metric_baselines.sql`
- Create: `tests/engine/schema/migrations/20260617000000_peer_metric_baselines.sql`

- [ ] **Step 1: Write the prod migration**

Create `supabase/migrations/20260617000000_peer_metric_baselines.sql`:

```sql
-- Peer Benchmarks — merchant-facing "your store vs your niche".
-- New prod table (codified, unlike the legacy moat schema), a public read
-- view over it, and the four KPI views + niche view that are the SHARED
-- definition for the Python writer and the TS reader.

create schema if not exists moat;

-- 1. The k-anonymized aggregate. n is always >= 5 (k-floor enforced in ETL);
--    the check fails loudly if a sub-floor row is ever inserted.
create table if not exists moat.peer_metric_baselines (
  metric_key  text          not null,
  segment     text          not null,
  p25         numeric(18,6) not null,
  p50         numeric(18,6) not null,
  p75         numeric(18,6) not null,
  n           integer       not null,
  computed_at timestamptz   not null default now(),
  primary key (metric_key, segment),
  check (n >= 5)
);

-- Engine role writes + deletes (delete-stale). NB: legacy moat.peer_baselines
-- was granted only select/insert/update even though consent_purge deletes from
-- it — we grant delete here to match actual usage. Guarded for prod, where the
-- custom roles may not exist.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_engine') then
    grant select, insert, update, delete on moat.peer_metric_baselines to app_engine;
  end if;
end $$;

-- 2. Public read surface (security DEFINER by default → reads moat under the
--    owner, so the public/service-role read path needs no moat grant). Safe:
--    the rows are k-anonymized aggregates, not per-shop data.
create or replace view public.v_peer_metric_baselines as
  select metric_key, segment, p25, p50, p75, n, computed_at
    from moat.peer_metric_baselines;

-- 3. KPI views — ONE shared definition per KPI, current_date-windowed.
--    security_invoker matches the v_order_ship_features convention; both
--    callers (service_role read path, engine ETL role) read cross-shop fine.
create or replace view public.v_peer_kpi_aov
  with (security_invoker = true) as
  select shop_id, (avg(total_cents) / 100.0)::numeric as value
    from public.order_fact
   where created_at_source >= (current_date - interval '30 days')
   group by shop_id;

create or replace view public.v_peer_kpi_return_rate
  with (security_invoker = true) as
  select shop_id,
         (sum(return_cents)::numeric / nullif(sum(revenue_cents), 0)) as value
    from public.sku_pnl
   where day >= (current_date - interval '30 days')
   group by shop_id;

create or replace view public.v_peer_kpi_gross_margin_pct
  with (security_invoker = true) as
  select shop_id,
         (sum(revenue_cents - cogs_cents)::numeric
            / nullif(sum(revenue_cents), 0)) as value
    from public.sku_pnl
   where day >= (current_date - interval '30 days')
   group by shop_id;

-- ponytail: orders with no resolved ship cost contribute null (sum skips them),
-- mildly undercounting; upgrade to weight by known-cost orders if it matters.
create or replace view public.v_peer_kpi_ship_cost_pct
  with (security_invoker = true) as
  select shop_id,
         (sum(coalesce(ship_cost_manual_cents, ship_cost_cents))::numeric
            / nullif(sum(total_cents), 0)) as value
    from public.order_fact
   where created_at_source >= (current_date - interval '30 days')
   group by shop_id;

-- 4. Niche view — dominant sku_dim.category by trailing-90d GMV. Mirrors
--    category_niche_for_shop (Python) for read-time (current_date). Tie-break
--    gmv desc, category asc — deterministic, matches the resolver.
create or replace view public.v_peer_shop_niche
  with (security_invoker = true) as
  with cat_gmv as (
    select p.shop_id, sd.category, sum(p.revenue_cents) as gmv_cents
      from public.sku_pnl p
      join public.sku_dim sd on sd.id = p.sku_id
     where sd.category is not null
       and p.day >= (current_date - interval '90 days')
     group by p.shop_id, sd.category
  ),
  ranked as (
    select shop_id, category,
           row_number() over (
             partition by shop_id order by gmv_cents desc, category asc
           ) as rn
      from cat_gmv
  )
  select shop_id, 'cat:' || category as segment
    from ranked where rn = 1;
```

- [ ] **Step 2: Write the test-schema migration**

Create `tests/engine/schema/migrations/20260617000000_peer_metric_baselines.sql`. Same as prod, but FIRST backfill the ship-cost columns the test schema lacks (they were only added in `supabase/migrations`, not mirrored into the test schema):

```sql
-- Test-DB parity. The test schema's order_fact predates the ship-cost work,
-- so add the two columns v_peer_kpi_ship_cost_pct references before the views.
-- ponytail: only the two columns the view needs, not the full ship-cost suite.
alter table public.order_fact
  add column if not exists ship_cost_cents        integer,
  add column if not exists ship_cost_manual_cents integer;

create schema if not exists moat;

create table if not exists moat.peer_metric_baselines (
  metric_key  text          not null,
  segment     text          not null,
  p25         numeric(18,6) not null,
  p50         numeric(18,6) not null,
  p75         numeric(18,6) not null,
  n           integer       not null,
  computed_at timestamptz   not null default now(),
  primary key (metric_key, segment),
  check (n >= 5)
);

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_engine') then
    grant select, insert, update, delete on moat.peer_metric_baselines to app_engine;
  end if;
end $$;

create or replace view public.v_peer_metric_baselines as
  select metric_key, segment, p25, p50, p75, n, computed_at
    from moat.peer_metric_baselines;

create or replace view public.v_peer_kpi_aov
  with (security_invoker = true) as
  select shop_id, (avg(total_cents) / 100.0)::numeric as value
    from public.order_fact
   where created_at_source >= (current_date - interval '30 days')
   group by shop_id;

create or replace view public.v_peer_kpi_return_rate
  with (security_invoker = true) as
  select shop_id,
         (sum(return_cents)::numeric / nullif(sum(revenue_cents), 0)) as value
    from public.sku_pnl
   where day >= (current_date - interval '30 days')
   group by shop_id;

create or replace view public.v_peer_kpi_gross_margin_pct
  with (security_invoker = true) as
  select shop_id,
         (sum(revenue_cents - cogs_cents)::numeric
            / nullif(sum(revenue_cents), 0)) as value
    from public.sku_pnl
   where day >= (current_date - interval '30 days')
   group by shop_id;

create or replace view public.v_peer_kpi_ship_cost_pct
  with (security_invoker = true) as
  select shop_id,
         (sum(coalesce(ship_cost_manual_cents, ship_cost_cents))::numeric
            / nullif(sum(total_cents), 0)) as value
    from public.order_fact
   where created_at_source >= (current_date - interval '30 days')
   group by shop_id;

create or replace view public.v_peer_shop_niche
  with (security_invoker = true) as
  with cat_gmv as (
    select p.shop_id, sd.category, sum(p.revenue_cents) as gmv_cents
      from public.sku_pnl p
      join public.sku_dim sd on sd.id = p.sku_id
     where sd.category is not null
       and p.day >= (current_date - interval '90 days')
     group by p.shop_id, sd.category
  ),
  ranked as (
    select shop_id, category,
           row_number() over (
             partition by shop_id order by gmv_cents desc, category asc
           ) as rn
      from cat_gmv
  )
  select shop_id, 'cat:' || category as segment
    from ranked where rn = 1;
```

- [ ] **Step 3: Apply the test-schema migration to the local test DB and verify objects exist**

Run (against your local `TEST_DATABASE_URL`):
```bash
psql "$TEST_DATABASE_URL" -f tests/engine/schema/migrations/20260617000000_peer_metric_baselines.sql
psql "$TEST_DATABASE_URL" -c "\d moat.peer_metric_baselines" -c "\dv public.v_peer_kpi_*" -c "\dv public.v_peer_shop_niche" -c "\dv public.v_peer_metric_baselines"
```
Expected: the table and all six views are listed.

- [ ] **Step 4: Validate the prod migration against the live prod schema (do NOT apply to prod yet)**

Use the Supabase MCP on a dev branch to confirm `public.sku_pnl`, `public.order_fact.ship_cost_cents`, `order_fact.ship_cost_manual_cents`, and schema `moat` all exist, then apply the migration to the branch:
```
mcp__plugin_supabase_supabase__list_tables (schemas: ["public","moat"])  → confirm sku_pnl, order_fact, moat
mcp__plugin_supabase_supabase__apply_migration (name: "peer_metric_baselines", query: <prod SQL>)  → on a dev branch
```
Expected: applies clean. If `app_engine` does not exist in prod, the guarded grant is a no-op — note this and confirm the engine's actual DB role can write to `moat.peer_metric_baselines` (replicate whatever role currently writes `moat.peer_baselines`). **Surface this explicitly; do not assume.**

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260617000000_peer_metric_baselines.sql \
        tests/engine/schema/migrations/20260617000000_peer_metric_baselines.sql
git commit -m "moat: add peer_metric_baselines table + KPI/niche/read views (peer benchmarks)"
```

---

## Task 2: Niche resolver — `category_niche_for_shop`

**Files:**
- Create: `engine/calderyn_engine/moat/peer_metrics_etl.py`
- Test: `tests/engine/moat/test_peer_metrics_etl.py`

- [ ] **Step 1: Write the failing test (dominant category, tie-break, no-sales, niche-view parity)**

Create `tests/engine/moat/test_peer_metrics_etl.py`:

```python
"""DB-backed tests for peer_metrics_etl. Skip unless a local TEST_DATABASE_URL
is set (inherits pg_pool + cleanup from the parent conftest)."""
from __future__ import annotations

import uuid
from datetime import date

import pytest

from calderyn_engine.moat.peer_metrics_etl import category_niche_for_shop

pytestmark = pytest.mark.asyncio

RUN_DATE = date(2026, 6, 17)


async def _seed_shop(conn, shop_id: str, *, consent: bool = True) -> None:
    suffix = shop_id.replace("-", "")[-12:]
    await conn.execute(
        "INSERT INTO public.shops (id, shop_domain, peer_data_consent) "
        "VALUES ($1::uuid, $2, $3) "
        "ON CONFLICT (id) DO UPDATE SET peer_data_consent = EXCLUDED.peer_data_consent",
        shop_id, f"pm-{suffix}.myshopify.com", consent,
    )


async def _seed_sku(conn, shop_id: str, category: str | None) -> str:
    sku_id = str(uuid.uuid4())
    await conn.execute(
        "INSERT INTO public.sku_dim (id, shop_id, external_id, product_id, title, category) "
        "VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)",
        sku_id, shop_id, f"ext-{sku_id[:8]}", f"prod-{sku_id[:8]}", "Item", category,
    )
    return sku_id


async def _seed_pnl(conn, shop_id: str, sku_id: str, *, day: date, revenue_cents: int) -> None:
    await conn.execute(
        "INSERT INTO public.sku_pnl "
        "(shop_id, sku_id, day, revenue_cents, cogs_cents, ad_spend_attrib_cents, "
        " contribution_margin_cents) "
        "VALUES ($1::uuid, $2::uuid, $3, $4, 0, 0, $4) "
        "ON CONFLICT (sku_id, day) DO UPDATE SET revenue_cents = EXCLUDED.revenue_cents",
        shop_id, sku_id, day, revenue_cents,
    )


async def test_dominant_category_wins(pg_pool):
    shop_id = str(uuid.uuid4())
    async with pg_pool.acquire() as conn:
        await _seed_shop(conn, shop_id)
        elec = await _seed_sku(conn, shop_id, "electronics")
        appa = await _seed_sku(conn, shop_id, "apparel")
        await _seed_pnl(conn, shop_id, elec, day=date(2026, 6, 1), revenue_cents=10_000)
        await _seed_pnl(conn, shop_id, appa, day=date(2026, 6, 1), revenue_cents=4_000)
        niche = await category_niche_for_shop(conn, shop_id, RUN_DATE)
    assert niche == "cat:electronics"


async def test_tie_breaks_alphabetically(pg_pool):
    shop_id = str(uuid.uuid4())
    async with pg_pool.acquire() as conn:
        await _seed_shop(conn, shop_id)
        a = await _seed_sku(conn, shop_id, "apparel")
        b = await _seed_sku(conn, shop_id, "books")
        await _seed_pnl(conn, shop_id, a, day=date(2026, 6, 1), revenue_cents=5_000)
        await _seed_pnl(conn, shop_id, b, day=date(2026, 6, 1), revenue_cents=5_000)
        niche = await category_niche_for_shop(conn, shop_id, RUN_DATE)
    assert niche == "cat:apparel"  # tie → alphabetical


async def test_no_sales_is_uncategorized(pg_pool):
    shop_id = str(uuid.uuid4())
    async with pg_pool.acquire() as conn:
        await _seed_shop(conn, shop_id)
        niche = await category_niche_for_shop(conn, shop_id, RUN_DATE)
    assert niche == "cat:uncategorized"


async def test_outside_90d_window_excluded(pg_pool):
    shop_id = str(uuid.uuid4())
    async with pg_pool.acquire() as conn:
        await _seed_shop(conn, shop_id)
        sku = await _seed_sku(conn, shop_id, "electronics")
        await _seed_pnl(conn, shop_id, sku, day=date(2026, 1, 1), revenue_cents=99_000)  # >90d
        niche = await category_niche_for_shop(conn, shop_id, RUN_DATE)
    assert niche == "cat:uncategorized"


async def test_resolver_matches_niche_view_for_today(pg_pool):
    """The Python resolver (run_date) and v_peer_shop_niche (current_date) are
    documented mirrors — pin them equal when run_date == today."""
    shop_id = str(uuid.uuid4())
    async with pg_pool.acquire() as conn:
        await _seed_shop(conn, shop_id)
        sku = await _seed_sku(conn, shop_id, "electronics")
        await _seed_pnl(conn, shop_id, sku, day=date.today(), revenue_cents=10_000)
        resolved = await category_niche_for_shop(conn, shop_id, date.today())
        row = await conn.fetchrow(
            "SELECT segment FROM public.v_peer_shop_niche WHERE shop_id = $1::uuid",
            shop_id,
        )
    assert resolved == "cat:electronics"
    assert row is not None and row["segment"] == resolved
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pytest tests/engine/moat/test_peer_metrics_etl.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'calderyn_engine.moat.peer_metrics_etl'` (or import error).

- [ ] **Step 3: Write the resolver**

Create `engine/calderyn_engine/moat/peer_metrics_etl.py` (resolver only for now):

```python
"""Peer Benchmarks ETL — merchant-facing "your store vs your niche".

Reuses the moat k-floor + pseudonym machinery. KPIs are read from the shared
``public.v_peer_kpi_*`` views so this writer and the TS reader compute the same
number. Privacy (A1): the cross-tenant aggregate sees only (pseudonym, segment,
value) — never raw shop_id.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Any

import structlog

from .peer_baselines import K_FLOOR
from .pseudonym import pseudonym_for

logger = structlog.get_logger(__name__)


async def category_niche_for_shop(conn: Any, shop_id: str, run_date: date) -> str:
    """Return ``cat:<category>`` for the shop's dominant category by trailing-90d
    GMV (sum of ``sku_pnl.revenue_cents`` joined to ``sku_dim.category``).

    Ties break alphabetically (deterministic — required by the moat re-aggregate
    / purge paths). No qualifying sales → ``cat:uncategorized``.

    Mirrors ``public.v_peer_shop_niche`` (current_date); kept in Python here
    because the ETL is run_date-parameterized. ``test_resolver_matches_niche_view
    _for_today`` guards the two encodings against drift.
    """
    row = await conn.fetchrow(
        """
        select sd.category
          from public.sku_pnl p
          join public.sku_dim sd on sd.id = p.sku_id
         where p.shop_id = $1::uuid
           and sd.category is not null
           and p.day >= ($2::date - interval '90 days')
           and p.day <  ($2::date + interval '1 day')
         group by sd.category
         order by sum(p.revenue_cents) desc, sd.category asc
         limit 1
        """,
        shop_id, run_date,
    )
    if row is None or row["category"] is None:
        return "cat:uncategorized"
    return f"cat:{row['category']}"
```

> Note: if `structlog` is not the engine's logger, copy the exact `logger = ...` line from `peer_incident_etl.py`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pytest tests/engine/moat/test_peer_metrics_etl.py -v`
Expected: PASS (all 5 tests).

- [ ] **Step 5: Commit**

```bash
git add engine/calderyn_engine/moat/peer_metrics_etl.py \
        tests/engine/moat/test_peer_metrics_etl.py
git commit -m "moat/peer_metrics: add category_niche_for_shop resolver"
```

---

## Task 3: Metric aggregate — `run_peer_metrics`

**Files:**
- Modify: `engine/calderyn_engine/moat/peer_metrics_etl.py`
- Test: `tests/engine/moat/test_peer_metrics_etl.py`

- [ ] **Step 1: Write the failing tests (k≥5 suppression, consent gating, quartiles, delete-stale)**

Append to `tests/engine/moat/test_peer_metrics_etl.py`:

```python
from decimal import Decimal

from calderyn_engine.moat.peer_metrics_etl import run_peer_metrics

PEPPER = "test-pepper-v1"


async def _seed_shop_in_niche(conn, shop_id, *, consent, category, aov_dollars):
    """Seed a consenting/non-consenting shop with one category and one order so
    its v_peer_kpi_aov value == aov_dollars and its niche == cat:<category>."""
    await _seed_shop(conn, shop_id, consent=consent)
    sku = await _seed_sku(conn, shop_id, category)
    await _seed_pnl(conn, shop_id, sku, day=date.today(), revenue_cents=10_000)
    await conn.execute(
        """
        INSERT INTO public.order_fact
          (id, shop_id, external_id, order_number, created_at_source,
           total_cents, subtotal_cents, source_version)
        VALUES (gen_random_uuid(), $1::uuid, $2, $3, now(),
                $4, $4, (extract(epoch from clock_timestamp())*1000)::bigint)
        """,
        shop_id, f"ord-{uuid.uuid4().hex[:8]}", f"#{uuid.uuid4().hex[:6]}",
        int(aov_dollars * 100),
    )


async def test_below_k_floor_writes_no_row(pg_pool):
    async with pg_pool.acquire() as conn:
        for d in (100, 200):  # only 2 consenting shops < K_FLOOR
            await _seed_shop_in_niche(conn, str(uuid.uuid4()),
                                      consent=True, category="electronics", aov_dollars=d)
        report = await run_peer_metrics(conn, run_date=date.today(), pepper=PEPPER)
        row = await conn.fetchrow(
            "SELECT * FROM moat.peer_metric_baselines "
            "WHERE metric_key='aov' AND segment='cat:electronics'"
        )
    assert row is None
    assert report.metrics_written == 0


async def test_five_consenting_shops_write_quartiles(pg_pool):
    async with pg_pool.acquire() as conn:
        for d in (100, 200, 300, 400, 500):
            await _seed_shop_in_niche(conn, str(uuid.uuid4()),
                                      consent=True, category="electronics", aov_dollars=d)
        await run_peer_metrics(conn, run_date=date.today(), pepper=PEPPER)
        row = await conn.fetchrow(
            "SELECT n, p25, p50, p75 FROM moat.peer_metric_baselines "
            "WHERE metric_key='aov' AND segment='cat:electronics'"
        )
    assert row["n"] == 5
    # percentile_cont over [100,200,300,400,500]
    assert row["p25"] == Decimal("200.000000")
    assert row["p50"] == Decimal("300.000000")
    assert row["p75"] == Decimal("400.000000")


async def test_non_consenting_excluded_from_count(pg_pool):
    async with pg_pool.acquire() as conn:
        for d in (100, 200, 300, 400):  # 4 consenting
            await _seed_shop_in_niche(conn, str(uuid.uuid4()),
                                      consent=True, category="books", aov_dollars=d)
        for d in (500, 600):  # 2 NON-consenting — must not lift count to 6
            await _seed_shop_in_niche(conn, str(uuid.uuid4()),
                                      consent=False, category="books", aov_dollars=d)
        await run_peer_metrics(conn, run_date=date.today(), pepper=PEPPER)
        row = await conn.fetchrow(
            "SELECT * FROM moat.peer_metric_baselines "
            "WHERE metric_key='aov' AND segment='cat:books'"
        )
    assert row is None  # only 4 consenting < K_FLOOR


async def test_delete_stale_when_drops_below_floor(pg_pool):
    seg = "cat:electronics"
    async with pg_pool.acquire() as conn:
        ids = [str(uuid.uuid4()) for _ in range(5)]
        for sid, d in zip(ids, (100, 200, 300, 400, 500)):
            await _seed_shop_in_niche(conn, sid, consent=True,
                                      category="electronics", aov_dollars=d)
        await run_peer_metrics(conn, run_date=date.today(), pepper=PEPPER)
        assert await conn.fetchrow(
            "SELECT 1 FROM moat.peer_metric_baselines "
            "WHERE metric_key='aov' AND segment=$1", seg) is not None
        # Two shops withdraw → 3 left < K_FLOOR → row must be deleted.
        await conn.execute(
            "UPDATE public.shops SET peer_data_consent=false WHERE id = ANY($1::uuid[])",
            ids[:2],
        )
        report = await run_peer_metrics(conn, run_date=date.today(), pepper=PEPPER)
        gone = await conn.fetchrow(
            "SELECT 1 FROM moat.peer_metric_baselines "
            "WHERE metric_key='aov' AND segment=$1", seg)
    assert gone is None
    assert report.segments_deleted >= 1
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pytest tests/engine/moat/test_peer_metrics_etl.py -k "floor or quartiles or consenting or stale" -v`
Expected: FAIL — `ImportError: cannot import name 'run_peer_metrics'`.

- [ ] **Step 3: Implement `run_peer_metrics` and the aggregate**

Append to `engine/calderyn_engine/moat/peer_metrics_etl.py`:

```python
# KPI key -> shared public view. Fixed allowlist (never user input) — the
# f-string interpolation below is therefore injection-safe.
METRIC_VIEWS: dict[str, str] = {
    "aov": "public.v_peer_kpi_aov",
    "return_rate": "public.v_peer_kpi_return_rate",
    "gross_margin_pct": "public.v_peer_kpi_gross_margin_pct",
    "ship_cost_pct": "public.v_peer_kpi_ship_cost_pct",
}

# A1: aggregate over pseudonyms + values only, never raw shop_id.
_AGG_SQL = """
with vals(pseudonym, segment, value) as (
  select * from unnest($1::text[], $2::text[], $3::numeric[])
)
select segment,
       count(distinct pseudonym) as n,
       percentile_cont(0.25) within group (order by value) as p25,
       percentile_cont(0.50) within group (order by value) as p50,
       percentile_cont(0.75) within group (order by value) as p75
  from vals
 group by segment
"""


@dataclass(frozen=True)
class PeerMetricsReport:
    metrics_written: int
    segments_deleted: int


async def _shop_values(conn: Any, view: str, shop_ids: list) -> dict[str, Any]:
    rows = await conn.fetch(
        f"select shop_id, value from {view} where shop_id = any($1::uuid[])",
        shop_ids,
    )
    return {str(r["shop_id"]): r["value"] for r in rows if r["value"] is not None}


async def run_peer_metrics(conn: Any, *, run_date: date, pepper: str) -> PeerMetricsReport:
    """Recompute every (metric_key, segment) baseline from the currently
    consenting shops. Idempotent. Caller owns the transaction and supplies the
    pepper (never reads env). delete-stale removes any segment that no longer
    reaches K_FLOOR (GDPR + churn)."""
    consenting = await conn.fetch(
        "select id from public.shops where peer_data_consent = true"
    )
    shop_ids = [r["id"] for r in consenting]

    if not shop_ids:
        # Nobody consents → table must be empty.
        deleted = 0
        for metric_key in METRIC_VIEWS:
            res = await conn.execute(
                "delete from moat.peer_metric_baselines where metric_key = $1",
                metric_key,
            )
            try:
                deleted += int(res.split()[-1])
            except (ValueError, IndexError):
                pass
        logger.info("peer_metrics_no_consent", segments_deleted=deleted)
        return PeerMetricsReport(metrics_written=0, segments_deleted=deleted)

    pseudonym = {str(sid): pseudonym_for(str(sid), pepper) for sid in shop_ids}
    niche: dict[str, str] = {}
    for sid in shop_ids:
        seg = await category_niche_for_shop(conn, sid, run_date)
        if seg != "cat:uncategorized":  # uncategorized never contributes (spec §2)
            niche[str(sid)] = seg

    written = 0
    deleted = 0
    for metric_key, view in METRIC_VIEWS.items():
        values = await _shop_values(conn, view, shop_ids)
        ps: list[str] = []
        segs: list[str] = []
        vals: list = []
        for sid_str, seg in niche.items():
            v = values.get(sid_str)
            if v is None:
                continue
            ps.append(pseudonym[sid_str])
            segs.append(seg)
            vals.append(v)

        rows = await conn.fetch(_AGG_SQL, ps, segs, vals)
        qualifying: set[str] = set()
        for row in rows:
            n = int(row["n"])
            if n < K_FLOOR:
                continue
            qualifying.add(row["segment"])
            await conn.execute(
                """
                insert into moat.peer_metric_baselines
                  (metric_key, segment, p25, p50, p75, n, computed_at)
                values ($1, $2, $3, $4, $5, $6, now())
                on conflict (metric_key, segment) do update set
                  p25 = excluded.p25, p50 = excluded.p50, p75 = excluded.p75,
                  n = excluded.n, computed_at = excluded.computed_at
                """,
                metric_key, row["segment"], row["p25"], row["p50"], row["p75"], n,
            )
            written += 1

        # delete-stale: any persisted segment for this metric that did NOT
        # re-qualify this run (dropped below K_FLOOR or vanished).
        existing = await conn.fetch(
            "select segment from moat.peer_metric_baselines where metric_key = $1",
            metric_key,
        )
        for er in existing:
            if er["segment"] not in qualifying:
                await conn.execute(
                    "delete from moat.peer_metric_baselines "
                    "where metric_key = $1 and segment = $2",
                    metric_key, er["segment"],
                )
                deleted += 1

    logger.info("peer_metrics_complete", metrics_written=written, segments_deleted=deleted)
    return PeerMetricsReport(metrics_written=written, segments_deleted=deleted)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pytest tests/engine/moat/test_peer_metrics_etl.py -v`
Expected: PASS (all tests, including the Task 2 ones).

- [ ] **Step 5: Commit**

```bash
git add engine/calderyn_engine/moat/peer_metrics_etl.py \
        tests/engine/moat/test_peer_metrics_etl.py
git commit -m "moat/peer_metrics: add run_peer_metrics aggregate (k-floor, consent gate, delete-stale)"
```

---

## Task 4: Wire into the nightly job + consent purge

**Files:**
- Modify: `engine/_moat_train_core.py`
- Modify: `engine/calderyn_engine/moat/consent_purge.py`
- Modify: caller(s) of `purge_shop_contributions`
- Test: `tests/engine/moat/test_peer_metrics_etl.py`, `tests/engine/moat/test_consent_purge.py`

- [ ] **Step 1: Write the failing test — nightly job runs metrics**

Append to `tests/engine/moat/test_peer_metrics_etl.py`:

```python
async def test_consent_purge_recomputes_metrics(pg_pool):
    """After a shop withdraws, purge_shop_contributions must re-run metrics so
    the surviving cohort drops below K_FLOOR and the row is deleted (GDPR)."""
    from calderyn_engine.moat.consent_purge import purge_shop_contributions

    seg = "cat:electronics"
    ids = [str(uuid.uuid4()) for _ in range(5)]
    async with pg_pool.acquire() as conn:
        for sid, d in zip(ids, (100, 200, 300, 400, 500)):
            await _seed_shop_in_niche(conn, sid, consent=True,
                                      category="electronics", aov_dollars=d)
        await run_peer_metrics(conn, run_date=date.today(), pepper=PEPPER)
        assert await conn.fetchrow(
            "SELECT 1 FROM moat.peer_metric_baselines "
            "WHERE metric_key='aov' AND segment=$1", seg) is not None

        # Withdraw 2 → set consent false, then purge by pseudonym.
        await conn.execute(
            "UPDATE public.shops SET peer_data_consent=false WHERE id=ANY($1::uuid[])",
            ids[:2],
        )
        for sid in ids[:2]:
            await purge_shop_contributions(
                conn, pseudonym_for(sid, PEPPER),
                pepper=PEPPER, run_date=date.today(),
            )
        gone = await conn.fetchrow(
            "SELECT 1 FROM moat.peer_metric_baselines "
            "WHERE metric_key='aov' AND segment=$1", seg)
    assert gone is None
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pytest tests/engine/moat/test_peer_metrics_etl.py::test_consent_purge_recomputes_metrics -v`
Expected: FAIL — `purge_shop_contributions()` got an unexpected keyword argument `pepper` (current signature is `(conn, shop_pseudonym)`).

- [ ] **Step 3a: Extend `purge_shop_contributions`**

In `engine/calderyn_engine/moat/consent_purge.py`, change the signature and add the metric recompute. Add the import near the existing moat imports:

```python
from .peer_metrics_etl import run_peer_metrics
```

Change the signature:

```python
async def purge_shop_contributions(
    conn: Any, shop_pseudonym: str, *, pepper: str, run_date: date
) -> int:
```

At the END of the function, just before `return deleted`, add:

```python
    # GDPR: the withdrawn shop already has peer_data_consent=false, so a full
    # metric recompute (delete-stale) removes it from peer_metric_baselines too.
    # ponytail: full recompute on purge is fine — purge is rare; target only
    # affected niches if it ever gets hot.
    await run_peer_metrics(conn, run_date=run_date, pepper=pepper)
```

Ensure `from datetime import date` is imported at the top (add if missing).

- [ ] **Step 3b: Update callers of `purge_shop_contributions`**

Find every caller and pass `pepper` + `run_date`:
```
mcp__codegraph__codegraph_callers (symbol: "purge_shop_contributions")
```
For each caller (e.g. the `moat:consent-revoked` pg-boss consumer), pass the moat pepper (the same env var the nightly job uses, `MOAT_PEPPER`) and today's date. Example edit shape:

```python
# before
await purge_shop_contributions(conn, shop_pseudonym)
# after
await purge_shop_contributions(
    conn, shop_pseudonym,
    pepper=os.environ["MOAT_PEPPER"], run_date=date.today(),
)
```
Also update the existing `test_consent_purge.py` call sites to pass `pepper=PEPPER, run_date=date.today()` (grep for `purge_shop_contributions(` in that file). Use whatever `PEPPER` constant that test already defines.

- [ ] **Step 3c: Wire the nightly job**

In `engine/_moat_train_core.py`, find the block:
```python
async with conn.transaction():
    etl_report = await run_peer_incident_etl(
        conn, run_date=run_date, pepper=pepper
    )
```
Add the metrics step inside the same transaction (one cron) and import it at the top of the file (`from calderyn_engine.moat.peer_metrics_etl import run_peer_metrics`):
```python
async with conn.transaction():
    etl_report = await run_peer_incident_etl(
        conn, run_date=run_date, pepper=pepper
    )
    await run_peer_metrics(conn, run_date=run_date, pepper=pepper)
```

- [ ] **Step 4: Run the targeted test + the full moat suite**

Run:
```bash
pytest tests/engine/moat/test_peer_metrics_etl.py::test_consent_purge_recomputes_metrics -v
pytest tests/engine/moat/ -v
```
Expected: the new test PASSES; the full moat suite stays green (the `test_consent_purge.py` call-site updates keep it passing).

- [ ] **Step 5: Commit**

```bash
git add engine/calderyn_engine/moat/consent_purge.py engine/_moat_train_core.py \
        tests/engine/moat/
# plus any caller file codegraph surfaced
git commit -m "moat: run peer_metrics in nightly job + consent purge (GDPR delete-stale)"
```

---

## Task 5: Read API — `getPeerBenchmarks`

**Files:**
- Create: `app/lib/benchmarks/types.ts`
- Create: `app/lib/benchmarks/peer-benchmarks.server.ts`
- Test: `app/lib/benchmarks/peer-benchmarks.server.test.ts`

- [ ] **Step 1: Write the shared types**

Create `app/lib/benchmarks/types.ts` (non-server so client components may import the types):

```typescript
export type MetricKey = "aov" | "return_rate" | "gross_margin_pct" | "ship_cost_pct";

export interface PeerKpi {
  metric_key: MetricKey;
  label: string;
  unit: "USD" | "ratio";
  your_value: number | null; // the requesting shop's own value (never gated)
  p25: number | null;
  p50: number | null;
  p75: number | null;
  n: number | null;
  percentile: number | null; // 1..99, approximate standing in the peer band
  available: boolean; // consented && n >= 5
}

export interface PeerBenchmarks {
  niche: string; // 'cat:<category>' or 'cat:uncategorized'
  consented: boolean;
  kpis: PeerKpi[];
}

export const KPI_META: Record<MetricKey, { label: string; unit: "USD" | "ratio" }> = {
  aov: { label: "Average order value", unit: "USD" },
  return_rate: { label: "30-day return rate", unit: "ratio" },
  gross_margin_pct: { label: "Gross margin", unit: "ratio" },
  ship_cost_pct: { label: "Ship cost % of revenue", unit: "ratio" },
};

export const KPI_VIEW: Record<MetricKey, string> = {
  aov: "v_peer_kpi_aov",
  return_rate: "v_peer_kpi_return_rate",
  gross_margin_pct: "v_peer_kpi_gross_margin_pct",
  ship_cost_pct: "v_peer_kpi_ship_cost_pct",
};
```

- [ ] **Step 2: Write the failing test**

Create `app/lib/benchmarks/peer-benchmarks.server.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";

// Programmable Supabase stub: maps table/view name -> rows.
let TABLES: Record<string, any[]> = {};

vi.mock("../supabase.server", () => ({
  resolveShopId: vi.fn().mockResolvedValue("shop-uuid"),
  getSupabase: () => ({
    from: (name: string) => {
      const rows = TABLES[name] ?? [];
      const builder: any = {
        _rows: rows,
        select() {
          return this;
        },
        eq(col: string, val: unknown) {
          this._rows = this._rows.filter((r: any) => r[col] === val);
          return this;
        },
        maybeSingle() {
          return Promise.resolve({ data: this._rows[0] ?? null, error: null });
        },
        then(resolve: (v: any) => void) {
          // awaiting the builder (no maybeSingle) resolves the list.
          resolve({ data: this._rows, error: null });
        },
      };
      return builder;
    },
  }),
}));

import { getPeerBenchmarks } from "./peer-benchmarks.server";

beforeEach(() => {
  TABLES = {};
});

function consentedElectronics() {
  TABLES["shops"] = [{ id: "shop-uuid", peer_data_consent: true }];
  TABLES["v_peer_shop_niche"] = [{ shop_id: "shop-uuid", segment: "cat:electronics" }];
  TABLES["v_peer_kpi_aov"] = [{ shop_id: "shop-uuid", value: 300 }];
  TABLES["v_peer_kpi_return_rate"] = [{ shop_id: "shop-uuid", value: 0.1 }];
  TABLES["v_peer_kpi_gross_margin_pct"] = [{ shop_id: "shop-uuid", value: 0.5 }];
  TABLES["v_peer_kpi_ship_cost_pct"] = [{ shop_id: "shop-uuid", value: 0.08 }];
  TABLES["v_peer_metric_baselines"] = [
    { metric_key: "aov", segment: "cat:electronics", p25: 200, p50: 300, p75: 400, n: 7 },
  ];
}

describe("getPeerBenchmarks", () => {
  it("returns available KPI with percentile when consented and n>=5", async () => {
    consentedElectronics();
    const out = await getPeerBenchmarks("test.myshopify.com");
    expect(out.niche).toBe("cat:electronics");
    expect(out.consented).toBe(true);
    const aov = out.kpis.find((k) => k.metric_key === "aov")!;
    expect(aov.your_value).toBe(300);
    expect(aov.available).toBe(true);
    expect(aov.n).toBe(7);
    expect(aov.percentile).toBe(50); // value == p50
  });

  it("shows your_value but gates peer fields when not consented", async () => {
    consentedElectronics();
    TABLES["shops"] = [{ id: "shop-uuid", peer_data_consent: false }];
    const out = await getPeerBenchmarks("test.myshopify.com");
    expect(out.consented).toBe(false);
    const aov = out.kpis.find((k) => k.metric_key === "aov")!;
    expect(aov.your_value).toBe(300); // own data still shown
    expect(aov.available).toBe(false);
    expect(aov.p50).toBeNull();
    expect(aov.percentile).toBeNull();
  });

  it("gates peer fields when consented but niche has no baseline (n<5)", async () => {
    consentedElectronics();
    TABLES["v_peer_metric_baselines"] = []; // niche < 5 peers → no row
    const out = await getPeerBenchmarks("test.myshopify.com");
    const aov = out.kpis.find((k) => k.metric_key === "aov")!;
    expect(aov.available).toBe(false);
    expect(aov.your_value).toBe(300);
  });

  it("reports uncategorized niche (UI hides the card)", async () => {
    consentedElectronics();
    TABLES["v_peer_shop_niche"] = []; // no dominant category
    const out = await getPeerBenchmarks("test.myshopify.com");
    expect(out.niche).toBe("cat:uncategorized");
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run app/lib/benchmarks/peer-benchmarks.server.test.ts`
Expected: FAIL — cannot resolve `./peer-benchmarks.server`.

- [ ] **Step 4: Implement `getPeerBenchmarks`**

Create `app/lib/benchmarks/peer-benchmarks.server.ts`:

```typescript
import { getSupabase, resolveShopId } from "../supabase.server";
import {
  KPI_META,
  KPI_VIEW,
  type MetricKey,
  type PeerBenchmarks,
  type PeerKpi,
} from "./types";

const K_FLOOR = 5;
const METRIC_KEYS = Object.keys(KPI_META) as MetricKey[];

/** Approximate standing in the peer band, piecewise-linear across the
 * quartiles, clamped to 1..99. "Approximate" per spec — no p0/p100 known. */
function percentileFromQuartiles(v: number, p25: number, p50: number, p75: number): number {
  const EPS = 1e-9;
  let pct: number;
  if (v <= p25) pct = p25 > 0 ? 25 * (v / p25) : 25;
  else if (v <= p50) pct = 25 + (25 * (v - p25)) / Math.max(p50 - p25, EPS);
  else if (v <= p75) pct = 50 + (25 * (v - p50)) / Math.max(p75 - p50, EPS);
  else pct = 75 + (25 * (v - p75)) / Math.max(p75 - p50, EPS);
  return Math.round(Math.min(99, Math.max(1, pct)));
}

export async function getPeerBenchmarks(shop: string): Promise<PeerBenchmarks> {
  const sb = getSupabase();
  const shopId = await resolveShopId(shop);

  const [{ data: shopRow }, { data: nicheRow }] = await Promise.all([
    sb.from("shops").select("peer_data_consent").eq("id", shopId).maybeSingle(),
    sb.from("v_peer_shop_niche").select("segment").eq("shop_id", shopId).maybeSingle(),
  ]);

  const consented = Boolean(shopRow?.peer_data_consent);
  const niche: string = nicheRow?.segment ?? "cat:uncategorized";

  // Own values from the shared KPI views (never gated).
  const ownValues = new Map<MetricKey, number | null>();
  await Promise.all(
    METRIC_KEYS.map(async (key) => {
      const { data } = await sb
        .from(KPI_VIEW[key])
        .select("value")
        .eq("shop_id", shopId)
        .maybeSingle();
      ownValues.set(key, data?.value ?? null);
    }),
  );

  // Peer baselines for this niche (skip the query if it can't be available).
  const baselines = new Map<MetricKey, { p25: number; p50: number; p75: number; n: number }>();
  if (consented && niche !== "cat:uncategorized") {
    const { data } = await sb
      .from("v_peer_metric_baselines")
      .select("metric_key, p25, p50, p75, n")
      .eq("segment", niche);
    for (const row of data ?? []) {
      baselines.set(row.metric_key as MetricKey, {
        p25: Number(row.p25),
        p50: Number(row.p50),
        p75: Number(row.p75),
        n: Number(row.n),
      });
    }
  }

  const kpis: PeerKpi[] = METRIC_KEYS.map((key) => {
    const your = ownValues.get(key) ?? null;
    const base = baselines.get(key);
    const available = consented && !!base && base.n >= K_FLOOR;
    return {
      metric_key: key,
      label: KPI_META[key].label,
      unit: KPI_META[key].unit,
      your_value: your === null ? null : Number(your),
      p25: available ? base!.p25 : null,
      p50: available ? base!.p50 : null,
      p75: available ? base!.p75 : null,
      n: available ? base!.n : null,
      percentile:
        available && your !== null
          ? percentileFromQuartiles(Number(your), base!.p25, base!.p50, base!.p75)
          : null,
      available,
    };
  });

  return { niche, consented, kpis };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run app/lib/benchmarks/peer-benchmarks.server.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add app/lib/benchmarks/
git commit -m "lib/benchmarks: add getPeerBenchmarks read path + types"
```

---

## Task 6: Polaris card (Shopify admin surface)

**Files:**
- Create: `app/components/calderyn/PeerBenchmarksCard.tsx`
- Test: `app/components/calderyn/__tests__/peer-benchmarks-card.test.tsx`
- Modify: `app/routes/app._index.tsx`

- [ ] **Step 1: Write the failing component test**

Create `app/components/calderyn/__tests__/peer-benchmarks-card.test.tsx`:

```typescript
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { AppProvider } from "@shopify/polaris";
import en from "@shopify/polaris/locales/en.json";
import { PeerBenchmarksCard } from "../PeerBenchmarksCard";
import type { PeerBenchmarks } from "~/lib/benchmarks/types";

function renderCard(data: PeerBenchmarks) {
  return render(
    <AppProvider i18n={en}>
      <PeerBenchmarksCard data={data} />
    </AppProvider>,
  );
}

const AVAILABLE: PeerBenchmarks = {
  niche: "cat:electronics",
  consented: true,
  kpis: [
    {
      metric_key: "aov",
      label: "Average order value",
      unit: "USD",
      your_value: 300,
      p25: 200,
      p50: 300,
      p75: 400,
      n: 7,
      percentile: 50,
      available: true,
    },
  ],
};

describe("PeerBenchmarksCard", () => {
  it("renders the niche and a KPI row with peer band when available", () => {
    renderCard(AVAILABLE);
    expect(screen.getByText(/Peer Benchmarks/i)).toBeInTheDocument();
    expect(screen.getByText("Average order value")).toBeInTheDocument();
    expect(screen.getByText(/electronics/i)).toBeInTheDocument();
    expect(screen.getByText(/7 peers/i)).toBeInTheDocument();
  });

  it("shows the opt-in prompt when not consented", () => {
    renderCard({ ...AVAILABLE, consented: false, kpis: [
      { ...AVAILABLE.kpis[0], available: false, p25: null, p50: null, p75: null, n: null, percentile: null },
    ] });
    expect(screen.getByText(/Share anonymized metrics/i)).toBeInTheDocument();
    // own value still shown
    expect(screen.getByText("$300.00")).toBeInTheDocument();
  });

  it("renders nothing for an uncategorized niche", () => {
    const { container } = renderCard({ niche: "cat:uncategorized", consented: true, kpis: [] });
    expect(container).toBeEmptyDOMElement();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run app/components/calderyn/__tests__/peer-benchmarks-card.test.tsx`
Expected: FAIL — cannot resolve `../PeerBenchmarksCard`.

- [ ] **Step 3: Implement the Polaris card**

Create `app/components/calderyn/PeerBenchmarksCard.tsx`:

```typescript
import { Badge, BlockStack, Card, InlineStack, Text } from "@shopify/polaris";
import type { PeerBenchmarks, PeerKpi } from "~/lib/benchmarks/types";

function fmtValue(kpi: PeerKpi, v: number | null): string {
  if (v === null) return "—";
  if (kpi.unit === "USD") return `$${v.toFixed(2)}`;
  return `${(v * 100).toFixed(1)}%`;
}

function categoryLabel(niche: string): string {
  return niche.startsWith("cat:") ? niche.slice(4) : niche;
}

/** Peer band p25–p75 with the store's marker at its percentile position.
 * Reuses the dashboard's `cdn-meter-track` styling (custom CSS). */
function PeerBand({ kpi }: { kpi: PeerKpi }) {
  if (!kpi.available || kpi.percentile === null) return null;
  return (
    <div className="cdn-meter-track" style={{ position: "relative" }}>
      <div
        className="cdn-meter-fill"
        style={{ transform: "scaleX(0.5)", transformOrigin: "left", opacity: 0.25 }}
      />
      <span
        aria-label={`${kpi.percentile}th percentile`}
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          left: `${kpi.percentile}%`,
          width: 2,
          background: "var(--p-color-text)",
        }}
      />
    </div>
  );
}

function KpiRow({ kpi }: { kpi: PeerKpi }) {
  return (
    <BlockStack gap="150">
      <InlineStack align="space-between" blockAlign="baseline">
        <Text as="span" variant="bodySm" tone="subdued">
          {kpi.label}
        </Text>
        <Text as="span" variant="bodyMd" fontWeight="semibold">
          <span className="cdn-tnum">{fmtValue(kpi, kpi.your_value)}</span>
        </Text>
      </InlineStack>
      {kpi.available ? (
        <>
          <PeerBand kpi={kpi} />
          <InlineStack align="space-between">
            <Text as="span" variant="bodySm" tone="subdued">
              peers {fmtValue(kpi, kpi.p25)}–{fmtValue(kpi, kpi.p75)}
            </Text>
            <Badge>{`${kpi.percentile}th pct · ${kpi.n} peers`}</Badge>
          </InlineStack>
        </>
      ) : null}
    </BlockStack>
  );
}

export function PeerBenchmarksCard({ data }: { data: PeerBenchmarks }) {
  if (data.niche === "cat:uncategorized") return null; // spec §7: card hidden

  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h2" variant="headingMd">
            Peer Benchmarks
          </Text>
          <Badge tone="info">{categoryLabel(data.niche)}</Badge>
        </InlineStack>

        {!data.consented ? (
          <Text as="p" variant="bodySm" tone="subdued">
            Share anonymized metrics to see how you compare — unlocks at 5 peers.
          </Text>
        ) : data.kpis.every((k) => !k.available) ? (
          <Text as="p" variant="bodySm" tone="subdued">
            Benchmarks unlock when 5+ {categoryLabel(data.niche)} stores opt in.
          </Text>
        ) : null}

        <BlockStack gap="400">
          {data.kpis.map((kpi) => (
            <KpiRow key={kpi.metric_key} kpi={kpi} />
          ))}
        </BlockStack>
      </BlockStack>
    </Card>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run app/components/calderyn/__tests__/peer-benchmarks-card.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire into the admin index loader + render**

In `app/routes/app._index.tsx`:

1. Add the import at the top:
```typescript
import { getPeerBenchmarks } from "~/lib/benchmarks/peer-benchmarks.server";
import { PeerBenchmarksCard } from "~/components/calderyn/PeerBenchmarksCard";
import type { PeerBenchmarks } from "~/lib/benchmarks/types";
```

2. Add `benchmarks` to the `Promise.all` in the loader (alongside the existing `client.*` calls):
```typescript
const [alerts, audit, campaigns, guardrails, benchmarks] = await Promise.all([
  client.alerts.list({ status: "open" }, request.signal),
  client.audit.list(request.signal),
  client.campaigns.list(request.signal),
  client.guardrails.get(request.signal),
  getPeerBenchmarks(session.shop),
]);
```

3. Add `benchmarks` to the `LoaderPayload` type and the `json<LoaderPayload>({...})` return:
```typescript
// in the LoaderPayload type:
benchmarks: PeerBenchmarks;
// in the json() call, add:
benchmarks,
```

4. In the component, destructure `benchmarks` from `useLoaderData<typeof loader>()` and render the card below the stat row (after the existing `<div className="cdn-stat-row">…</div>`):
```typescript
const { /* …existing…, */ benchmarks } = useLoaderData<typeof loader>();
// …in JSX, after the stat row:
<PeerBenchmarksCard data={benchmarks} />
```

> If the catch-path of the loader returns a fallback `LoaderPayload`, add a dormant default there too: `benchmarks: { niche: "cat:uncategorized", consented: false, kpis: [] }`.

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck`
Expected: exit 0.

```bash
git add app/components/calderyn/PeerBenchmarksCard.tsx \
        app/components/calderyn/__tests__/peer-benchmarks-card.test.tsx \
        app/routes/app._index.tsx
git commit -m "app._index: add Peer Benchmarks Polaris card"
```

---

## Task 7: Dashboard card (Calderyn dashboard surface)

**Files:**
- Create: `app/routes/dashboard.api.benchmarks.tsx`
- Create: `app/components/dashboard/screens/PeerBenchmarks.tsx`
- Test: `app/components/dashboard/screens/__tests__/peer-benchmarks.test.ts`
- Modify: `app/components/dashboard/screens/Dashboard.tsx`

- [ ] **Step 1: Write the dashboard data route**

Create `app/routes/dashboard.api.benchmarks.tsx` (mirror `dashboard.api.overview.tsx`):

```typescript
import type { LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson } from "~/lib/dashboard/json.server";
import { getPeerBenchmarks } from "~/lib/benchmarks/peer-benchmarks.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  return dashboardJson(async () => getPeerBenchmarks(session.shopDomain));
}
```

> Match the exact import paths used by `app/routes/dashboard.api.overview.tsx` for `requireDashboardSession` / `dashboardJson` (copy them from that file — names may differ slightly).

- [ ] **Step 2: Write the failing dashboard card test**

Create `app/components/dashboard/screens/__tests__/peer-benchmarks.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import { PeerBenchmarks } from "../PeerBenchmarks";
import type { PeerBenchmarks as Data } from "~/lib/benchmarks/types";

const AVAILABLE: Data = {
  niche: "cat:electronics",
  consented: true,
  kpis: [
    {
      metric_key: "aov",
      label: "Average order value",
      unit: "USD",
      your_value: 300,
      p25: 200,
      p50: 300,
      p75: 400,
      n: 7,
      percentile: 50,
      available: true,
    },
  ],
};

describe("dashboard PeerBenchmarks", () => {
  it("renders the niche label and KPI when available", () => {
    const html = renderToString(h(PeerBenchmarks, { data: AVAILABLE })).replace(/<!-- -->/g, "");
    expect(html).toContain("Peer Benchmarks");
    expect(html).toContain("Average order value");
    expect(html).toContain("electronics");
    expect(html).toContain("7 peers");
  });

  it("renders the opt-in prompt when not consented", () => {
    const data: Data = {
      ...AVAILABLE,
      consented: false,
      kpis: [{ ...AVAILABLE.kpis[0], available: false, p25: null, p50: null, p75: null, n: null, percentile: null }],
    };
    const html = renderToString(h(PeerBenchmarks, { data })).replace(/<!-- -->/g, "");
    expect(html).toContain("Share anonymized metrics");
    expect(html).toContain("$300.00");
  });

  it("renders empty for an uncategorized niche", () => {
    const html = renderToString(
      h(PeerBenchmarks, { data: { niche: "cat:uncategorized", consented: true, kpis: [] } }),
    );
    expect(html).toBe("");
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run app/components/dashboard/screens/__tests__/peer-benchmarks.test.ts`
Expected: FAIL — cannot resolve `../PeerBenchmarks`.

- [ ] **Step 4: Implement the dashboard card (own primitives, NO Polaris)**

Create `app/components/dashboard/screens/PeerBenchmarks.tsx`:

```typescript
import { Card, Meter, Pill } from "~/components/dashboard/ui";
import type { PeerBenchmarks as Data, PeerKpi } from "~/lib/benchmarks/types";

function fmtValue(kpi: PeerKpi, v: number | null): string {
  if (v === null) return "—";
  return kpi.unit === "USD" ? `$${v.toFixed(2)}` : `${(v * 100).toFixed(1)}%`;
}

function categoryLabel(niche: string): string {
  return niche.startsWith("cat:") ? niche.slice(4) : niche;
}

function KpiRow({ kpi }: { kpi: PeerKpi }) {
  return (
    <div className="cd-benchmark-row">
      <div className="cd-row-between">
        <span className="cd-stat-label">{kpi.label}</span>
        <span className="cd-stat-value tabular-nums">{fmtValue(kpi, kpi.your_value)}</span>
      </div>
      {kpi.available && kpi.percentile !== null ? (
        <>
          <Meter pct={kpi.percentile} tone="accent" />
          <div className="cd-row-between">
            <span className="cd-caption">
              peers {fmtValue(kpi, kpi.p25)}–{fmtValue(kpi, kpi.p75)}
            </span>
            <Pill tone="accent">{`${kpi.percentile}th pct · ${kpi.n} peers`}</Pill>
          </div>
        </>
      ) : null}
    </div>
  );
}

export function PeerBenchmarks({ data }: { data: Data }) {
  if (data.niche === "cat:uncategorized") return null; // spec §7: card hidden

  const noneAvailable = data.kpis.every((k) => !k.available);
  return (
    <Card className="cd-benchmarks">
      <div className="cd-row-between">
        <span className="cd-section-title">Peer Benchmarks</span>
        <Pill tone="neutral">{categoryLabel(data.niche)}</Pill>
      </div>
      {!data.consented ? (
        <span className="cd-caption">
          Share anonymized metrics to see how you compare — unlocks at 5 peers.
        </span>
      ) : noneAvailable ? (
        <span className="cd-caption">
          Benchmarks unlock when 5+ {categoryLabel(data.niche)} stores opt in.
        </span>
      ) : null}
      {data.kpis.map((kpi) => (
        <KpiRow key={kpi.metric_key} kpi={kpi} />
      ))}
    </Card>
  );
}
```

> Use whatever class names the dashboard already defines for label/value/caption (copy from `Dashboard.tsx` — e.g. `cd-stat-label`, `cd-stat-value`, `cd-caption`, `cd-section-title`). `cd-benchmark-row` / `cd-row-between` are layout helpers; add them to `app/styles/dashboard.css` only if no equivalent exists (a flex `justify-content: space-between` row).

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run app/components/dashboard/screens/__tests__/peer-benchmarks.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Render the card + fetch its data**

In `app/components/dashboard/screens/Dashboard.tsx`:

1. Add imports:
```typescript
import { useEffect, useState } from "react";
import { PeerBenchmarks } from "./PeerBenchmarks";
import type { PeerBenchmarks as BenchmarksData } from "~/lib/benchmarks/types";
```

2. Inside the `Dashboard` component, self-fetch the benchmarks. **ponytail:** the card fetches its own data rather than threading through `DashboardCtx` — smallest diff; promote into the context loader if another screen needs it:
```typescript
const [benchmarks, setBenchmarks] = useState<BenchmarksData | null>(null);
useEffect(() => {
  let alive = true;
  fetch("/dashboard/api/benchmarks")
    .then((r) => r.json())
    .then((d) => {
      if (alive) setBenchmarks(d as BenchmarksData);
    })
    .catch(() => {});
  return () => {
    alive = false;
  };
}, []);
```

3. Render it after the `cd-stat-grid` block:
```typescript
{benchmarks ? <PeerBenchmarks data={benchmarks} /> : null}
```

- [ ] **Step 7: Typecheck + commit**

Run: `npm run typecheck`
Expected: exit 0.

```bash
git add app/routes/dashboard.api.benchmarks.tsx \
        app/components/dashboard/screens/PeerBenchmarks.tsx \
        app/components/dashboard/screens/__tests__/peer-benchmarks.test.ts \
        app/components/dashboard/screens/Dashboard.tsx
git commit -m "dashboard: add Peer Benchmarks card + data route (parity)"
```

---

## Final gate (per CLAUDE.md pre-commit gate — run before any PR)

- [ ] `pytest tests/engine/ -v` → all green (engine).
- [ ] `npx vitest run` → all green (TS).
- [ ] `npm run typecheck` → exit 0.
- [ ] `npm run lint` → exit 0 (`--max-warnings=0` on touched files).
- [ ] `npm run build` → exit 0.
- [ ] `npx prisma migrate diff --exit-code` is N/A (no Prisma schema change); the SQL migrations are validated via the Supabase MCP branch apply in Task 1 Step 4.
- [ ] `/code-review` on the working tree → resolve blockers.

---

## Self-review (plan vs spec)

- **§2 Niche** → Task 2 (`category_niche_for_shop`, run_date, tie-break, uncategorized) + `v_peer_shop_niche` + parity test. ✓
- **§3 KPIs** → four `public.v_peer_kpi_*` views (Task 1). AOV from `order_fact`; return_rate & gross_margin from `sku_pnl`; ship_cost_pct from `order_fact` resolved ship cost. ✓ (Deviation from spec's "source view" column documented: 2 named views didn't exist; replaced with concrete per-shop views.)
- **§4 Data model** → `moat.peer_metric_baselines` with `check (n >= 5)`, prod + test migrations (Task 1). ✓
- **§5 Write path** → `peer_metrics_etl.run_peer_metrics`, consent gate, k-floor, delete-stale, wired into nightly job + consent purge (Tasks 3–4). ✓
- **§5 Read path** → `getPeerBenchmarks(shop)` returning `{niche, consented, kpis}`, percentile, `available` gating (Task 5). ✓
- **§5 UI both surfaces** → Polaris card (Task 6) + dashboard card with own primitives (Task 7). ✓
- **§6 Privacy A1/A2/A3** → aggregate SQL takes only (pseudonym, segment, value); consent filter on `peer_data_consent`; `count(distinct pseudonym) >= K_FLOOR`; own value ungated. ✓
- **§7 Empty states** → not-consented prompt, niche<5 prompt, uncategorized hidden — covered in both cards + tests. ✓
- **§8 Build slices** → Tasks 1–7 map 1:1 to slices 1–7. ✓
- **§9 Non-goals** → no extra KPIs, no time-series, detector baselines untouched, niche derived. ✓

**Type consistency:** `MetricKey`, `PeerKpi`, `PeerBenchmarks`, `KPI_META`, `KPI_VIEW` defined once in `app/lib/benchmarks/types.ts` and imported everywhere; Python `METRIC_VIEWS` keys match the four `metric_key` strings; view names match between migration, `KPI_VIEW`, and `METRIC_VIEWS`.

**Open risk to confirm at execution (not a blocker):** the prod engine DB role's write/delete grant on `moat.peer_metric_baselines` (the `app_engine` role may not exist in prod; the legacy `moat.peer_baselines` lacks a `delete` grant despite `consent_purge` deleting from it). Task 1 Step 4 surfaces this; replicate whatever role actually writes `moat.peer_baselines` today.
