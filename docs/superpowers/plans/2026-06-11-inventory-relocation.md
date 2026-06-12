# Inventory Relocation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show each product's main demand region on the inventory page (both surfaces) and let merchants execute a prefilled, editable inventory transfer that goes through the same audit/undo pipeline as alert-driven `reallocate_inventory`.

**Architecture:** A new Supabase view `v_sku_regional_demand` computes per-SKU demand-by-region (same SQL shape as the `regional_shortage_risk` detector) plus transfer candidates. The shared client merges it into the SKU DTO; a pure TS module derives the suggested transfer. A new executor `executeInventoryRelocation` (mirroring `executeReallocation` for budgets) validates server-side and records append-only audit rows. The Polaris page and the dashboard each get a demand column + relocate dialog calling the same executor through their own route patterns.

**Tech Stack:** Remix (Vite), Polaris, Supabase (PostgREST + raw SQL view), Shopify Admin GraphQL (`inventoryAdjustQuantities`), vitest, pytest (engine schema tests).

**Spec:** `docs/superpowers/specs/2026-06-11-inventory-relocation-design.md`

**Naming deviation from spec (intentional):** the spec named the executor `executeRelocation` in `app/lib/actions/relocate.server.ts`. `app/lib/actions/reallocate.server.ts` already exports `executeReallocation` (BUDGET reallocation) — near-identical names are a hazard. This plan uses **`executeInventoryRelocation`** in **`app/lib/actions/inventory-relocate.server.ts`** instead.

**Pre-existing gap surfaced during planning:** `undoAction` (`app/lib/actions/undo.server.ts:81`) throws "undo not supported" for `reallocate_inventory`, while `v_audit_view.undo_eligible` marks those rows eligible and the alert UI promises "Reversible via Undo". Task 6 closes that gap for both alert-driven and page-initiated transfers.

---

## Context for a zero-context engineer

- **Repo rules:** `CLAUDE.md` at repo root. TypeScript strict; loaders read-only; actions validate FormData at the boundary; never leak Prisma/Supabase rows — shape DTOs; rule 12: fail visibly, never record success past a skipped step.
- **Worktree (MANDATORY):** all work happens in a dedicated worktree, never on the current checkout.
- **Two surfaces:** Polaris embedded app (`app/routes/app.skus.tsx`) and the dashboard SPA (`app/components/dashboard/screens/Inventory.tsx` + `app/routes/dashboard.api.*` JSON routes). Same repo, same DB, different UI primitives. Mirror behavior, not JSX.
- **Key existing code to read before starting:**
  - `app/lib/shopify/inventory.server.ts` — `inventoryAdjustQuantities(admin, input)`, `AdminGraphqlClient`, `InventoryAdjustInput`.
  - `app/lib/actions/execute.server.ts` — `priorExecutionForKey`, `insertAuditWithIdempotency`, `ExecutedAudit`.
  - `app/lib/actions/reallocate.server.ts` — the budget executor this one mirrors (validation-throws vs failure-records pattern).
  - `app/routes/dashboard.api.alerts.$id.action.tsx` — the dashboard write-route template.
  - `app/lib/dashboard/__tests__/api-write-routes.test.ts` — the vi.mock harness for dashboard routes.
  - DB facts (live schema): `sku_dim(id, shop_id, sku, title, inventory_item_id, …)`, `location_dim(id, shop_id, external_id, name, region, active)`, `inventory_level_fact(shop_id, sku_id, location_id, available, observed_at)`, `order_line_fact`/`order_fact`/`fulfillment_fact`. `external_id`/`inventory_item_id` hold full Shopify GIDs (e.g. `gid://shopify/Location/77`).
  - `v_skus_flat` anchors its 30-day velocity window to `max(order_fact.created_at_source)` per shop (demo-data friendly), NOT `now()`. The new view must use the same anchor so the demand column never disagrees with the velocity column beside it.
- **Commands:** `npm run typecheck`, `npm run lint`, `npm run build`, `npm test` (vitest), `npx vitest run <file>`. Engine tests: `TEST_DATABASE_URL=postgres://postgres:test@localhost:5432/calderyn_test python -m pytest tests/engine/unit/<file> -v` (refuses non-local hosts). Engine test schema = `tests/engine/schema/migrations/*.sql`, applied with psql (see Task 2).

## File map

| File | Status | Responsibility |
|---|---|---|
| `supabase/migrations/20260611120000_v_sku_regional_demand.sql` | create | The demand/candidates view (prod) |
| `tests/engine/schema/migrations/20260611120000_v_sku_regional_demand.sql` | create | Same file, test-schema copy |
| `tests/engine/unit/test_view_sku_regional_demand.py` | create | View contract tests |
| `app/lib/types.ts` | modify | `SKU.demand`, `SKU.suggested_transfer`, `SKU.locations_detail`, `ShopLocation` |
| `app/lib/inventory-demand.ts` | create | Pure derivation: view row → demand + suggested transfer |
| `app/lib/__tests__/inventory-demand.test.ts` | create | Unit tests for derivation |
| `app/lib/calderyn.server.ts` | modify | `skus.list()` merge + `locations.list()` |
| `app/lib/actions/inventory-relocate.server.ts` | create | `executeInventoryRelocation` + `RelocationError` |
| `app/lib/actions/__tests__/inventory-relocate.test.ts` | create | Executor tests |
| `app/lib/actions/undo.server.ts` | modify | `reallocate_inventory` undo branch (needs `deps.admin`) |
| `app/routes/dashboard.api.audit.$id.undo.tsx` | modify | Pass admin client into `undoAction` |
| `app/routes/app.skus.tsx` | modify | Demand column, Relocate modal, route `action` |
| `app/routes/__tests__/skus-action.test.ts` | create | Extension action tests |
| `app/routes/dashboard.api.skus.$id.relocate.tsx` | create | Dashboard write route |
| `app/lib/dashboard/__tests__/skus-relocate-route.test.ts` | create | Dashboard route tests |
| `app/lib/dashboard/client.ts` | modify | `SkuVM` demand fields via `adaptSku`, `relocateSku()` |
| `app/components/dashboard/view-models.ts` | modify | `SkuVM` additions |
| `app/components/dashboard/screens/Inventory.tsx` | modify | Demand column + relocate dialog |

---

### Task 1: Worktree setup

- [ ] **Step 1: Create the isolated worktree** (repo rule: never feature-work on the live checkout)

```bash
cd /Users/ericchen/Developer/shopify-app
git worktree add .claude/worktrees/inventory-relocation -b feat/inventory-relocation
cd .claude/worktrees/inventory-relocation
npm install
```

Expected: worktree at `.claude/worktrees/inventory-relocation` on branch `feat/inventory-relocation`. All subsequent tasks run inside it.

---

### Task 2: `v_sku_regional_demand` view (migration + pytest contract test)

**Files:**
- Create: `supabase/migrations/20260611120000_v_sku_regional_demand.sql`
- Create: `tests/engine/schema/migrations/20260611120000_v_sku_regional_demand.sql` (identical copy)
- Test: `tests/engine/unit/test_view_sku_regional_demand.py`

- [ ] **Step 1: Write the failing test**

The test reuses `seed_regional_shortage_scenario` (`tests/engine/conftest.py:1748`): it seeds SKU `dddddddd-…-dddd1111`, a focus-region location (`external_id='loc-rs-region'`, name `Region WH`), an `NY` location (`external_id='loc-rs-other'`, name `Other WH`), in-region stock, and a 30-day order+fulfillment in the focus region.

```python
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
```

Note: `source_version` is a plain bigint on `inventory_level_fact` (see the fixture's `_next_source_version()`); the literal `999999` avoids colliding with fixture-generated versions. If insert fails on a unique constraint, use `_next_source_version`'s pattern from conftest.

- [ ] **Step 2: Run it to make sure it fails**

```bash
# One-time local test DB (skip if already running — conftest skips without TEST_DATABASE_URL):
docker run -d --name calderyn-test-pg -e POSTGRES_PASSWORD=test -e POSTGRES_DB=calderyn_test -p 5432:5432 postgres:17
export PGPASSWORD=test
psql -h localhost -U postgres -d calderyn_test -v ON_ERROR_STOP=1 -f tests/engine/schema/000_roles.sql
for f in tests/engine/schema/migrations/*.sql; do psql -h localhost -U postgres -d calderyn_test -v ON_ERROR_STOP=1 -f "$f"; done

TEST_DATABASE_URL=postgres://postgres:test@localhost:5432/calderyn_test \
  python -m pytest tests/engine/unit/test_view_sku_regional_demand.py -v
```

Expected: FAIL — `relation "public.v_sku_regional_demand" does not exist`.

- [ ] **Step 3: Write the migration** (both copies — identical content)

```sql
-- v_sku_regional_demand: per-SKU demand by region + transfer candidates for
-- the inventory page (embedded app + dashboard). Demand attribution matches
-- the regional_shortage_risk detector (order lines -> successful fulfillment
-- -> location_dim.region); the 30-day window anchors to the shop's latest
-- order like v_skus_flat, so the demand column never disagrees with the
-- velocity column rendered beside it.
create or replace view public.v_sku_regional_demand as
with max_order_day as (
  select shop_id, max(created_at_source) as anchor_ts
  from public.order_fact
  group by shop_id
),
latest_inv as (
  select distinct on (i.sku_id, i.location_id)
         i.shop_id, i.sku_id, i.location_id, i.available
  from public.inventory_level_fact i
  order by i.sku_id, i.location_id, i.observed_at desc
),
regional_demand as (
  select ol.shop_id, ol.sku_id, l.region,
         sum(ol.quantity)::numeric / 30.0 as daily_demand
  from public.order_line_fact ol
  join public.order_fact o on o.id = ol.order_id and o.shop_id = ol.shop_id
  join max_order_day m on m.shop_id = ol.shop_id
  join public.fulfillment_fact f
    on f.order_id = ol.order_id and f.shop_id = ol.shop_id and f.status = 'success'
  join public.location_dim l on l.id = f.location_id
  where o.created_at_source > (m.anchor_ts - interval '30 days')
    and o.created_at_source <= m.anchor_ts
    and ol.sku_id is not null
    and l.region is not null
  group by ol.shop_id, ol.sku_id, l.region
),
top_region as (
  select distinct on (rd.shop_id, rd.sku_id)
         rd.shop_id, rd.sku_id, rd.region, rd.daily_demand
  from regional_demand rd
  order by rd.shop_id, rd.sku_id, rd.daily_demand desc, rd.region asc
),
total_demand as (
  select shop_id, sku_id, sum(daily_demand) as total_daily_demand
  from regional_demand
  group by shop_id, sku_id
),
stock_by_region as (
  select li.shop_id, li.sku_id, l.region, sum(li.available) as qty
  from latest_inv li
  join public.location_dim l on l.id = li.location_id
  group by li.shop_id, li.sku_id, l.region
)
select tr.shop_id,
       tr.sku_id,
       tr.region                                    as main_demand_region,
       round(tr.daily_demand * 30)::int             as demand_units_30d,
       tr.daily_demand,
       case when td.total_daily_demand > 0
            then tr.daily_demand / td.total_daily_demand
            else 0 end                              as demand_share,
       coalesce(sbr.qty, 0)::int                    as stock_in_region,
       dest.external_id                             as dest_location_external_id,
       dest.name                                    as dest_location_name,
       src.external_id                              as src_location_external_id,
       src.name                                     as src_location_name,
       coalesce(src.available, 0)::int              as src_available,
       d.inventory_item_id,
       loc.locations_detail
from top_region tr
join total_demand td on td.shop_id = tr.shop_id and td.sku_id = tr.sku_id
left join stock_by_region sbr
  on sbr.shop_id = tr.shop_id and sbr.sku_id = tr.sku_id
 and sbr.region is not distinct from tr.region
left join public.sku_dim d on d.id = tr.sku_id
-- Destination: deterministic active location IN the demand region (same
-- LATERAL pick as the regional_spend_starved_stock detector).
left join lateral (
  select l.external_id, l.name
  from public.location_dim l
  where l.shop_id = tr.shop_id and l.region = tr.region and l.active
  order by l.external_id
  limit 1
) dest on true
-- Source: largest available holder OUTSIDE the demand region.
left join lateral (
  select l.external_id, l.name, li.available
  from latest_inv li
  join public.location_dim l on l.id = li.location_id
  where li.shop_id = tr.shop_id and li.sku_id = tr.sku_id
    and l.region is distinct from tr.region
    and li.available > 0
  order by li.available desc, l.external_id
  limit 1
) src on true
-- Per-SKU location detail (GIDs + availability) for the relocate modal's
-- source select. Keyed by external_id because SKU.locations (v_skus_flat)
-- is keyed by display name, which the Shopify mutation can't use.
left join lateral (
  select jsonb_agg(
           jsonb_build_object(
             'external_id', l.external_id,
             'name', l.name,
             'region', l.region,
             'available', li.available)
           order by li.available desc, l.external_id) as locations_detail
  from latest_inv li
  join public.location_dim l on l.id = li.location_id
  where li.shop_id = tr.shop_id and li.sku_id = tr.sku_id
) loc on true;

-- Match every other view in this schema (20260604140000_views_security_invoker.sql).
alter view public.v_sku_regional_demand set (security_invoker = on);
```

- [ ] **Step 4: Apply to the local test DB and run the test**

```bash
psql -h localhost -U postgres -d calderyn_test -v ON_ERROR_STOP=1 \
  -f tests/engine/schema/migrations/20260611120000_v_sku_regional_demand.sql
TEST_DATABASE_URL=postgres://postgres:test@localhost:5432/calderyn_test \
  python -m pytest tests/engine/unit/test_view_sku_regional_demand.py -v
```

Expected: 2 passed. If `demand_share`/column types mismatch, fix the VIEW, not the test.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260611120000_v_sku_regional_demand.sql \
        tests/engine/schema/migrations/20260611120000_v_sku_regional_demand.sql \
        tests/engine/unit/test_view_sku_regional_demand.py
git commit -m "db: v_sku_regional_demand view — per-SKU demand region + transfer candidates

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

> The production migration is applied at deploy time like every other file in `supabase/migrations/` — do NOT run it against prod by hand.

---

### Task 3: DTO extension + pure derivation module

**Files:**
- Modify: `app/lib/types.ts` (the `SKU` interface, currently line 83)
- Create: `app/lib/inventory-demand.ts`
- Test: `app/lib/__tests__/inventory-demand.test.ts`

- [ ] **Step 1: Extend the types**

In `app/lib/types.ts`, add above `export interface SKU`:

```ts
export interface SkuLocationDetail {
  /** Shopify Location GID (location_dim.external_id). */
  id: string;
  name: string;
  region: string | null;
  available: number;
}

export interface SkuDemand {
  region: string;
  units_30d: number;
  /** Fraction (0..1) of this SKU's total 30-day demand in that region. */
  share: number;
  stock_in_region: number;
}

export interface SuggestedTransfer {
  inventory_item_id: string;
  from_location_id: string;
  from_location_name: string;
  to_location_id: string;
  to_location_name: string;
  recommended_delta: number;
}

export interface ShopLocation {
  /** Shopify Location GID. */
  id: string;
  name: string;
  region: string | null;
  active: boolean;
}
```

And extend `SKU`:

```ts
export interface SKU {
  id: string;
  title: string;
  on_hand: number;
  days_of_cover: number;
  velocity: number;
  locations: Record<string, number>;
  sources: SkuSource[];
  /** null when the SKU has no 30-day sales. */
  demand: SkuDemand | null;
  /** null when no demand/stock mismatch or no viable source+destination. */
  suggested_transfer: SuggestedTransfer | null;
  /** Per-location availability with Shopify GIDs (relocate modal source options). */
  locations_detail: SkuLocationDetail[];
}
```

- [ ] **Step 2: Write the failing derivation tests**

```ts
import { describe, it, expect } from "vitest";
import {
  demandFromRow,
  suggestedTransferFromRow,
  type SkuDemandViewRow,
} from "../inventory-demand";

const ROW: SkuDemandViewRow = {
  sku_id: "sku-1",
  main_demand_region: "CA",
  demand_units_30d: 300,
  daily_demand: "10",
  demand_share: "0.75",
  stock_in_region: 5,
  dest_location_external_id: "gid://shopify/Location/2",
  dest_location_name: "LA Warehouse",
  src_location_external_id: "gid://shopify/Location/9",
  src_location_name: "NY Warehouse",
  src_available: 80,
  inventory_item_id: "gid://shopify/InventoryItem/1",
  locations_detail: [
    { external_id: "gid://shopify/Location/9", name: "NY Warehouse", region: "NY", available: 80 },
    { external_id: "gid://shopify/Location/2", name: "LA Warehouse", region: "CA", available: 5 },
  ],
};

describe("demandFromRow", () => {
  it("maps the view row into the SKU demand shape", () => {
    expect(demandFromRow(ROW)).toEqual({
      region: "CA",
      units_30d: 300,
      share: 0.75,
      stock_in_region: 5,
    });
  });
});

describe("suggestedTransferFromRow", () => {
  it("suggests min(weekly shortfall, source availability)", () => {
    // weekly demand 70, in-region 5 => shortfall 65; src has 80 => delta 65.
    expect(suggestedTransferFromRow(ROW)).toEqual({
      inventory_item_id: "gid://shopify/InventoryItem/1",
      from_location_id: "gid://shopify/Location/9",
      from_location_name: "NY Warehouse",
      to_location_id: "gid://shopify/Location/2",
      to_location_name: "LA Warehouse",
      recommended_delta: 65,
    });
  });

  it("caps the delta at source availability", () => {
    expect(
      suggestedTransferFromRow({ ...ROW, src_available: 40 })?.recommended_delta,
    ).toBe(40);
  });

  it("returns null when the region already holds a week of demand", () => {
    expect(suggestedTransferFromRow({ ...ROW, stock_in_region: 70 })).toBeNull();
  });

  it("returns null without a viable source, destination, or inventory item", () => {
    expect(suggestedTransferFromRow({ ...ROW, src_location_external_id: null })).toBeNull();
    expect(suggestedTransferFromRow({ ...ROW, dest_location_external_id: null })).toBeNull();
    expect(suggestedTransferFromRow({ ...ROW, inventory_item_id: null })).toBeNull();
  });

  it("returns null when source and destination are the same location", () => {
    expect(
      suggestedTransferFromRow({
        ...ROW,
        src_location_external_id: ROW.dest_location_external_id,
      }),
    ).toBeNull();
  });

  it("returns null when there is no demand", () => {
    expect(suggestedTransferFromRow({ ...ROW, daily_demand: "0" })).toBeNull();
  });
});
```

- [ ] **Step 3: Run to verify failure**

```bash
npx vitest run app/lib/__tests__/inventory-demand.test.ts
```

Expected: FAIL — `Cannot find module '../inventory-demand'`.

- [ ] **Step 4: Implement `app/lib/inventory-demand.ts`**

```ts
// Pure derivation from a v_sku_regional_demand row to the SKU DTO's demand +
// suggested-transfer fields. Presentation policy lives HERE (not SQL) so both
// surfaces — and the unit tests — share one definition of "mismatch":
// the main demand region holds less than 7 days of its own demand and stock
// exists elsewhere to cover (part of) the gap.

import type { SkuDemand, SkuLocationDetail, SuggestedTransfer } from "./types";

/** Raw row shape from PostgREST. numerics arrive as strings. */
export interface SkuDemandViewRow {
  sku_id: string;
  main_demand_region: string;
  demand_units_30d: number;
  daily_demand: string | number;
  demand_share: string | number;
  stock_in_region: number;
  dest_location_external_id: string | null;
  dest_location_name: string | null;
  src_location_external_id: string | null;
  src_location_name: string | null;
  src_available: number;
  inventory_item_id: string | null;
  locations_detail:
    | Array<{ external_id: string; name: string; region: string | null; available: number }>
    | null;
}

export function demandFromRow(r: SkuDemandViewRow): SkuDemand {
  return {
    region: r.main_demand_region,
    units_30d: Number(r.demand_units_30d ?? 0),
    share: Number(r.demand_share ?? 0),
    stock_in_region: Number(r.stock_in_region ?? 0),
  };
}

export function locationsDetailFromRow(r: SkuDemandViewRow): SkuLocationDetail[] {
  return (r.locations_detail ?? []).map((l) => ({
    id: l.external_id,
    name: l.name,
    region: l.region,
    available: Number(l.available ?? 0),
  }));
}

export function suggestedTransferFromRow(r: SkuDemandViewRow): SuggestedTransfer | null {
  const dailyDemand = Number(r.daily_demand ?? 0);
  if (dailyDemand <= 0) return null;
  const shortfall = Math.ceil(dailyDemand * 7 - Number(r.stock_in_region ?? 0));
  if (shortfall < 1) return null;
  if (!r.inventory_item_id || !r.dest_location_external_id || !r.src_location_external_id) {
    return null;
  }
  if (r.dest_location_external_id === r.src_location_external_id) return null;
  const delta = Math.min(shortfall, Number(r.src_available ?? 0));
  if (delta < 1) return null;
  return {
    inventory_item_id: r.inventory_item_id,
    from_location_id: r.src_location_external_id,
    from_location_name: r.src_location_name ?? r.src_location_external_id,
    to_location_id: r.dest_location_external_id,
    to_location_name: r.dest_location_name ?? r.dest_location_external_id,
    recommended_delta: delta,
  };
}
```

- [ ] **Step 5: Run tests + typecheck.** `rowToSku` in `app/lib/calderyn.server.ts` no longer satisfies `SKU` — fix it in the same step by defaulting the new fields (real values arrive in Task 4):

```ts
function rowToSku(r: Record<string, unknown>, sources: SkuSource[] = []): SKU {
  return {
    id: String(r.id),
    title: String(r.title),
    on_hand: Number(r.on_hand ?? 0),
    days_of_cover: Number(r.days_of_cover ?? 0),
    velocity: Number(r.velocity ?? 0),
    locations: (r.locations as Record<string, number>) ?? {},
    sources,
    demand: null,
    suggested_transfer: null,
    locations_detail: [],
  };
}
```

```bash
npx vitest run app/lib/__tests__/inventory-demand.test.ts && npm run typecheck
```

Expected: tests PASS, `tsc` exit 0 (if other files break on the new required fields, default them the same way — they are data-source merges, not UI).

- [ ] **Step 6: Commit**

```bash
git add app/lib/types.ts app/lib/inventory-demand.ts app/lib/__tests__/inventory-demand.test.ts app/lib/calderyn.server.ts
git commit -m "lib: SKU demand/suggested-transfer DTO + pure derivation from v_sku_regional_demand

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Shared client — merge demand into `skus.list()`, add `locations.list()`

**Files:**
- Modify: `app/lib/calderyn.server.ts` (`skus` section, ~line 666)

- [ ] **Step 1: Extend `skus.list()`** — add a 4th parallel query and merge:

```ts
const [skuRes, cogsRes, adMapRes, demandRes] = await Promise.all([
  supabase
    .from("v_skus_flat")
    .select("*")
    .eq("shop_id", shopId)
    .order("on_hand", { ascending: false }),
  supabase
    .from("cogs_fact")
    .select("sku_id, source")
    .eq("shop_id", shopId)
    .limit(10000),
  supabase
    .from("ad_creative_sku_map")
    .select("sku_id, platform")
    .eq("shop_id", shopId)
    .limit(10000),
  // One row per SKU-with-sales; explicit cap per the PostgREST 1000-row
  // default-truncation convention above.
  supabase
    .from("v_sku_regional_demand")
    .select("*")
    .eq("shop_id", shopId)
    .limit(10000),
]);
if (skuRes.error) throw skuRes.error;
if (cogsRes.error) throw cogsRes.error;
if (adMapRes.error) throw adMapRes.error;
if (demandRes.error) throw demandRes.error;
```

then after `sourcesBySku` is built:

```ts
const demandBySku = new Map<string, SkuDemandViewRow>();
for (const r of (demandRes.data ?? []) as unknown as SkuDemandViewRow[]) {
  demandBySku.set(String(r.sku_id), r);
}

return (skuRes.data ?? []).map((r) => {
  const set = sourcesBySku.get(String(r.id));
  const sources = set ? SKU_SOURCE_ORDER.filter((s) => set.has(s)) : [];
  const sku = rowToSku(r, sources);
  const demandRow = demandBySku.get(sku.id);
  if (demandRow) {
    sku.demand = demandFromRow(demandRow);
    sku.suggested_transfer = suggestedTransferFromRow(demandRow);
    sku.locations_detail = locationsDetailFromRow(demandRow);
  }
  return sku;
});
```

with imports at the top of the file:

```ts
import {
  demandFromRow,
  locationsDetailFromRow,
  suggestedTransferFromRow,
  type SkuDemandViewRow,
} from "./inventory-demand";
```

- [ ] **Step 2: Add `locations.list()`** as a sibling section to `skus` (the relocate modal's destination select needs every active location, including ones holding none of the SKU):

```ts
locations: {
  async list(_signal?: AbortSignal): Promise<ShopLocation[]> {
    try {
      const shopId = await shopIdP;
      const { data, error } = await supabase
        .from("location_dim")
        .select("external_id, name, region, active")
        .eq("shop_id", shopId)
        .order("name", { ascending: true })
        .limit(1000);
      if (error) throw error;
      return (data ?? []).map((r) => ({
        id: String(r.external_id),
        name: String(r.name ?? r.external_id),
        region: r.region == null ? null : String(r.region),
        active: Boolean(r.active),
      }));
    } catch (err) {
      rethrow("locations.list", err);
    }
  },
},
```

(`ShopLocation` imported from `./types`.)

- [ ] **Step 3: Verify**

```bash
npm run typecheck && npm test
```

Expected: exit 0, full vitest suite green (existing suites mock `calderynClient`, so no breakage; if a mocked client object now misses `locations`, add it only where a test exercises it).

- [ ] **Step 4: Commit**

```bash
git add app/lib/calderyn.server.ts
git commit -m "lib/calderyn.server: merge v_sku_regional_demand into skus.list, add locations.list

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: `executeInventoryRelocation` executor (TDD)

**Files:**
- Create: `app/lib/actions/inventory-relocate.server.ts`
- Test: `app/lib/actions/__tests__/inventory-relocate.test.ts`

Contract (mirrors `executeReallocation`):
- Replayed idempotency key → prior REAL outcome.
- Validation/ownership failures **throw** (`RelocationError` with a stable `code`) and write **no** audit row — nothing was attempted.
- A Shopify mutation failure **records a failed audit row** with `last_error` and returns `outcome: "failed"` (rule 12).
- `inventory_item_id` is derived from `sku_dim`, never the caller. Locations are shop-scoped via `location_dim`. Availability is re-checked fresh from `inventory_level_fact` (loader snapshots not trusted).
- The success params match the alert-driven `reallocate_inventory` shape (`inventory_item_id`, `from_location_id`, `to_location_id`, `delta`, `shopify_operation_id`) so the audit page and Task 6's undo treat both identically.

- [ ] **Step 1: Write the failing tests.** Mock supabase with a chainable stub per table (same style as the existing `app/lib/actions/__tests__` suites — read one for the local `mockSb` idiom and reuse it):

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  executeInventoryRelocation,
  RelocationError,
} from "../inventory-relocate.server";

const priorExecutionForKey = vi.fn();
const insertAuditWithIdempotency = vi.fn();
vi.mock("../execute.server", () => ({
  priorExecutionForKey: (...a: unknown[]) => priorExecutionForKey(...a),
  insertAuditWithIdempotency: (...a: unknown[]) => insertAuditWithIdempotency(...a),
}));

const inventoryAdjustQuantities = vi.fn();
vi.mock("../../shopify/inventory.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shopify/inventory.server")>()),
  inventoryAdjustQuantities: (...a: unknown[]) => inventoryAdjustQuantities(...a),
}));

const SHOP = "shop-1";
const ADMIN = { graphql: vi.fn() };
const INPUT = {
  alertId: null,
  skuId: "sku-1",
  fromLocationId: "gid://shopify/Location/9",
  toLocationId: "gid://shopify/Location/2",
  quantity: 40,
  idempotencyKey: "idem-1",
};

// Rows returned by the mock supabase, keyed by table.
let skuRow: Record<string, unknown> | null;
let locRows: Array<Record<string, unknown>>;
let invRow: Record<string, unknown> | null;

function mockSb() {
  const result = (table: string) => {
    if (table === "sku_dim") return { data: skuRow, error: null };
    if (table === "location_dim") return { data: locRows, error: null };
    return { data: invRow, error: null }; // inventory_level_fact
  };
  const builder = (table: string) => {
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "order", "limit"]) {
      b[m] = vi.fn(() => b);
    }
    b.maybeSingle = vi.fn(async () => result(table));
    // location_dim list resolves the builder itself (awaited thenable).
    b.then = (resolve: (v: unknown) => void) => resolve(result(table));
    return b;
  };
  return { from: vi.fn((table: string) => builder(table)) } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  priorExecutionForKey.mockResolvedValue(null);
  insertAuditWithIdempotency.mockImplementation(async (_s, _k, audit) => ({
    id: "audit-1",
    outcome: audit.outcome,
  }));
  inventoryAdjustQuantities.mockResolvedValue({ operationId: "gid://op/1" });
  skuRow = {
    id: "sku-1",
    title: "Widget",
    sku: "W-1",
    inventory_item_id: "gid://shopify/InventoryItem/1",
  };
  locRows = [
    { id: "loc-a", external_id: "gid://shopify/Location/9", name: "NY", active: true },
    { id: "loc-b", external_id: "gid://shopify/Location/2", name: "LA", active: true },
  ];
  invRow = { available: 80, observed_at: "2026-06-11T00:00:00Z" };
});

describe("executeInventoryRelocation", () => {
  it("moves stock, records a succeeded audit with the alert-shaped params", async () => {
    const res = await executeInventoryRelocation(SHOP, INPUT, mockSb(), ADMIN);
    expect(res.outcome).toBe("succeeded");
    expect(inventoryAdjustQuantities).toHaveBeenCalledWith(ADMIN, {
      inventoryItemId: "gid://shopify/InventoryItem/1",
      fromLocationId: "gid://shopify/Location/9",
      toLocationId: "gid://shopify/Location/2",
      delta: 40,
    });
    const [, , audit] = insertAuditWithIdempotency.mock.calls[0];
    expect(audit.action_kind).toBe("reallocate_inventory");
    expect(audit.alert_id).toBeNull();
    expect(audit.params).toMatchObject({
      inventory_item_id: "gid://shopify/InventoryItem/1",
      from_location_id: "gid://shopify/Location/9",
      to_location_id: "gid://shopify/Location/2",
      delta: 40,
      shopify_operation_id: "gid://op/1",
      target: "Widget",
    });
    expect(audit.pre_state).toEqual({ from_location_available: 80 });
    expect(audit.post_state).toEqual({ from_location_available: 40 });
  });

  it("returns the prior outcome on a replayed idempotency key", async () => {
    priorExecutionForKey.mockResolvedValue({ id: "audit-0", outcome: "failed" });
    const res = await executeInventoryRelocation(SHOP, INPUT, mockSb(), ADMIN);
    expect(res).toEqual({ id: "audit-0", outcome: "failed" });
    expect(inventoryAdjustQuantities).not.toHaveBeenCalled();
  });

  it.each([
    ["zero quantity", { quantity: 0 }, "INVALID_QUANTITY"],
    ["fractional quantity", { quantity: 1.5 }, "INVALID_QUANTITY"],
    ["same location", { toLocationId: INPUT.fromLocationId }, "SAME_LOCATION"],
  ])("throws %s with no audit row", async (_n, patch, code) => {
    await expect(
      executeInventoryRelocation(SHOP, { ...INPUT, ...patch }, mockSb(), ADMIN),
    ).rejects.toMatchObject({ code });
    expect(insertAuditWithIdempotency).not.toHaveBeenCalled();
  });

  it("throws SKU_NOT_FOUND for a foreign or missing sku", async () => {
    skuRow = null;
    await expect(
      executeInventoryRelocation(SHOP, INPUT, mockSb(), ADMIN),
    ).rejects.toMatchObject({ code: "SKU_NOT_FOUND" });
  });

  it("throws INVALID_TRANSFER_PLAN when a location is foreign or inactive", async () => {
    locRows = [locRows[0]]; // destination missing
    await expect(
      executeInventoryRelocation(SHOP, INPUT, mockSb(), ADMIN),
    ).rejects.toMatchObject({ code: "INVALID_TRANSFER_PLAN" });
  });

  it("throws QTY_EXCEEDS_AVAILABLE against FRESH availability", async () => {
    invRow = { available: 39 };
    await expect(
      executeInventoryRelocation(SHOP, INPUT, mockSb(), ADMIN),
    ).rejects.toMatchObject({ code: "QTY_EXCEEDS_AVAILABLE" });
    expect(inventoryAdjustQuantities).not.toHaveBeenCalled();
  });

  it("records a FAILED audit row when Shopify rejects the mutation (rule 12)", async () => {
    inventoryAdjustQuantities.mockRejectedValue(new Error("ERR: location disabled"));
    const res = await executeInventoryRelocation(SHOP, INPUT, mockSb(), ADMIN);
    expect(res.outcome).toBe("failed");
    const [, , audit] = insertAuditWithIdempotency.mock.calls[0];
    expect(audit.outcome).toBe("failed");
    expect(audit.last_error).toContain("location disabled");
    expect(audit.post_state).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
npx vitest run app/lib/actions/__tests__/inventory-relocate.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `app/lib/actions/inventory-relocate.server.ts`**

```ts
// Execute a merchant-initiated inventory relocation from the inventory page:
// move N units of a SKU between two Shopify locations. Same audit contract as
// alert-driven reallocate_inventory (app.alerts.$id.tsx) — identical params
// shape, append-only action_audit row, idempotency-key dedup — but the inputs
// arrive from a form, so EVERYTHING that drives the mutation is re-derived
// from shop-scoped records: inventory_item_id from sku_dim, location
// ownership from location_dim, availability fresh from inventory_level_fact.
// Validation failures THROW with no audit row (nothing was attempted);
// Shopify failures record a failed row visibly (rule 12).

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  inventoryAdjustQuantities,
  type AdminGraphqlClient,
} from "../shopify/inventory.server";
import {
  insertAuditWithIdempotency,
  priorExecutionForKey,
  type ExecutedAudit,
} from "./execute.server";

export interface InventoryRelocationInput {
  alertId: string | null;
  skuId: string;
  /** Shopify Location GIDs (location_dim.external_id). */
  fromLocationId: string;
  toLocationId: string;
  quantity: number;
  idempotencyKey: string;
  actor?: string;
}

/** Validation failure: thrown BEFORE any side effect; no audit row exists. */
export class RelocationError extends Error {
  constructor(
    public readonly code:
      | "INVALID_QUANTITY"
      | "SAME_LOCATION"
      | "SKU_NOT_FOUND"
      | "INVALID_TRANSFER_PLAN"
      | "QTY_EXCEEDS_AVAILABLE",
    message: string,
  ) {
    super(message);
    this.name = "RelocationError";
  }
}

export async function executeInventoryRelocation(
  shopId: string,
  input: InventoryRelocationInput,
  sb: SupabaseClient,
  admin: AdminGraphqlClient,
): Promise<ExecutedAudit> {
  const prior = await priorExecutionForKey(shopId, input.idempotencyKey, sb);
  if (prior) return prior;

  if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
    throw new RelocationError("INVALID_QUANTITY", "Quantity must be a positive whole number.");
  }
  if (input.fromLocationId === input.toLocationId) {
    throw new RelocationError("SAME_LOCATION", "Source and destination must be different locations.");
  }

  const { data: sku, error: sErr } = await sb
    .from("sku_dim")
    .select("id, title, sku, inventory_item_id")
    .eq("shop_id", shopId)
    .eq("id", input.skuId)
    .maybeSingle();
  if (sErr) throw sErr;
  if (!sku) {
    throw new RelocationError("SKU_NOT_FOUND", "SKU not found for this shop.");
  }
  if (!sku.inventory_item_id) {
    throw new RelocationError(
      "INVALID_TRANSFER_PLAN",
      "This SKU has no Shopify inventory item, so stock can't be moved.",
    );
  }

  const { data: locs, error: lErr } = await sb
    .from("location_dim")
    .select("id, external_id, name, active")
    .eq("shop_id", shopId)
    .in("external_id", [input.fromLocationId, input.toLocationId]);
  if (lErr) throw lErr;
  const rows = (locs ?? []) as Array<{
    id: string;
    external_id: string;
    name: string;
    active: boolean;
  }>;
  const from = rows.find((l) => l.external_id === input.fromLocationId);
  const to = rows.find((l) => l.external_id === input.toLocationId);
  if (!from || !to) {
    throw new RelocationError("INVALID_TRANSFER_PLAN", "Location does not belong to this shop.");
  }
  if (!to.active) {
    throw new RelocationError("INVALID_TRANSFER_PLAN", "The destination location is inactive.");
  }

  // Fresh availability — the page's loader snapshot may be stale.
  const { data: inv, error: iErr } = await sb
    .from("inventory_level_fact")
    .select("available, observed_at")
    .eq("shop_id", shopId)
    .eq("sku_id", input.skuId)
    .eq("location_id", from.id)
    .order("observed_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (iErr) throw iErr;
  const fromAvailable = Number(inv?.available ?? 0);
  if (input.quantity > fromAvailable) {
    throw new RelocationError(
      "QTY_EXCEEDS_AVAILABLE",
      `Only ${fromAvailable} unit${fromAvailable === 1 ? "" : "s"} available at ${from.name}.`,
    );
  }

  let outcome: ExecutedAudit["outcome"] = "succeeded";
  let lastError: string | null = null;
  let operationId: string | null = null;
  try {
    ({ operationId } = await inventoryAdjustQuantities(admin, {
      inventoryItemId: String(sku.inventory_item_id),
      fromLocationId: input.fromLocationId,
      toLocationId: input.toLocationId,
      delta: input.quantity,
    }));
  } catch (err) {
    outcome = "failed";
    lastError = err instanceof Error ? err.message : String(err);
  }

  return insertAuditWithIdempotency(
    shopId,
    input.idempotencyKey,
    {
      alert_id: input.alertId,
      action_kind: "reallocate_inventory",
      params: {
        target: String(sku.title ?? sku.sku ?? input.skuId),
        sku: sku.sku,
        sku_id: input.skuId,
        inventory_item_id: sku.inventory_item_id,
        from_location_id: input.fromLocationId,
        from_location_name: from.name,
        to_location_id: input.toLocationId,
        to_location_name: to.name,
        delta: input.quantity,
        shopify_operation_id: operationId,
      },
      outcome,
      pre_state: { from_location_available: fromAvailable },
      post_state:
        outcome === "succeeded"
          ? { from_location_available: fromAvailable - input.quantity }
          : null,
      last_error: lastError,
      actor_user_id: input.actor ?? "merchant",
    },
    sb,
  );
}
```

- [ ] **Step 4: Run to verify pass**

```bash
npx vitest run app/lib/actions/__tests__/inventory-relocate.test.ts && npm run typecheck
```

Expected: all PASS, tsc exit 0. (If `insertAuditWithIdempotency`'s `AuditInsert` type rejects a field, match its actual shape in `execute.server.ts` — do not widen the type.)

- [ ] **Step 5: Commit**

```bash
git add app/lib/actions/inventory-relocate.server.ts app/lib/actions/__tests__/inventory-relocate.test.ts
git commit -m "actions: executeInventoryRelocation — form-driven inventory transfer with audit parity

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Undo support for `reallocate_inventory`

**Files:**
- Modify: `app/lib/actions/undo.server.ts`
- Modify: `app/routes/dashboard.api.audit.$id.undo.tsx`
- Modify: `app/lib/calderyn.server.ts` (legacy `audit.undo`, ~line 316 — delegate like `reallocate_budget` does at line 334)
- Test: extend `app/lib/actions/__tests__/` (colocate with the existing undo tests if present, else `app/lib/actions/__tests__/undo-inventory.test.ts`)

- [ ] **Step 1: Write the failing tests** (`app/lib/actions/__tests__/undo-inventory.test.ts`; mock style as Task 5):

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { undoAction } from "../undo.server";

const inventoryAdjustQuantities = vi.fn();
vi.mock("../../shopify/inventory.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shopify/inventory.server")>()),
  inventoryAdjustQuantities: (...a: unknown[]) => inventoryAdjustQuantities(...a),
}));
vi.mock("../../ads/action-registry.server", () => ({
  actionAdapterForShop: vi.fn(async () => null),
}));

const ORIG = {
  id: "audit-1",
  shop_id: "shop-1",
  alert_id: null,
  action_kind: "reallocate_inventory",
  params: {
    inventory_item_id: "gid://shopify/InventoryItem/1",
    from_location_id: "gid://shopify/Location/9",
    to_location_id: "gid://shopify/Location/2",
    delta: 40,
  },
  pre_state: { from_location_available: 80 },
  post_state: { from_location_available: 40 },
  dollar_impact_at_exec: 0,
};

function mockSb(orig: Record<string, unknown> | null) {
  const single = vi.fn(async () => ({ data: { id: "audit-undo-1" }, error: null }));
  const builder: Record<string, unknown> = {};
  for (const m of ["select", "eq", "update", "insert", "order", "limit"]) {
    builder[m] = vi.fn(() => builder);
  }
  builder.maybeSingle = vi.fn(async () => ({ data: orig, error: null }));
  builder.single = single;
  return { from: vi.fn(() => builder) } as never;
}

const ADMIN = { graphql: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  inventoryAdjustQuantities.mockResolvedValue({ operationId: "gid://op/undo" });
});

describe("undoAction for reallocate_inventory", () => {
  it("fires the REVERSE transfer (locations swapped) and records the undo row", async () => {
    const res = await undoAction("shop-1", "audit-1", mockSb(ORIG), { admin: ADMIN });
    expect(inventoryAdjustQuantities).toHaveBeenCalledWith(ADMIN, {
      inventoryItemId: "gid://shopify/InventoryItem/1",
      fromLocationId: "gid://shopify/Location/2", // original destination
      toLocationId: "gid://shopify/Location/9", // original source
      delta: 40,
    });
    expect(res.id).toBe("audit-undo-1");
  });

  it("refuses loudly when no Shopify admin client is supplied", async () => {
    await expect(undoAction("shop-1", "audit-1", mockSb(ORIG))).rejects.toThrow(
      /Shopify admin/i,
    );
    expect(inventoryAdjustQuantities).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run app/lib/actions/__tests__/undo-inventory.test.ts`. Expected: FAIL ("undo not supported for action kind reallocate_inventory").

- [ ] **Step 3: Implement.** In `undo.server.ts`:

1. Extend the signature:

```ts
import { inventoryAdjustQuantities, type AdminGraphqlClient } from "../shopify/inventory.server";

export async function undoAction(
  shopId: string,
  auditId: string,
  sb: SupabaseClient,
  deps: { admin?: AdminGraphqlClient } = {},
): Promise<{ id: string }> {
```

2. The kinds below need an ad-platform adapter, but `reallocate_inventory` does not — move the `actionAdapterForShop` resolution + `adapter not connected` throw INSIDE the campaign branches (it currently runs unconditionally at line 24; an inventory undo must not require an ads integration).

3. Add the branch before the final `else`:

```ts
} else if (orig.action_kind === "reallocate_inventory") {
  // Reverse transfer: same inventory item, locations swapped. Refuse loudly
  // without an admin client rather than record a success that never touched
  // Shopify (rule 12).
  if (!deps.admin) {
    throw new Error("Shopify admin client unavailable; cannot undo an inventory transfer");
  }
  const ip = (orig.params ?? {}) as {
    inventory_item_id?: string;
    from_location_id?: string;
    to_location_id?: string;
    delta?: number;
  };
  const delta = Number(ip.delta ?? 0);
  if (!ip.inventory_item_id || !ip.from_location_id || !ip.to_location_id || !delta) {
    throw new Error(`audit ${auditId} lacks a replayable transfer plan; cannot undo`);
  }
  await inventoryAdjustQuantities(deps.admin, {
    inventoryItemId: ip.inventory_item_id,
    fromLocationId: ip.to_location_id,
    toLocationId: ip.from_location_id,
    delta,
  });
}
```

4. In `dashboard.api.audit.$id.undo.tsx`, build the admin client like `dashboard.api.alerts.$id.action.tsx` does and pass it:

```ts
const { admin } = await unauthenticated.admin(session.shopDomain);
const res = await undoAction(session.shopId, auditId, getSupabase(), { admin });
```

(import `unauthenticated` from `~/shopify.server`; keep the route's existing error mapping.)

5. In `calderyn.server.ts`'s legacy `audit.undo`, extend the existing delegation guard (line 334) to cover inventory, constructing the admin client from the shop domain the client was built with:

```ts
if (orig.action_kind === "reallocate_budget" || orig.action_kind === "reallocate_inventory") {
  const deps =
    orig.action_kind === "reallocate_inventory"
      ? { admin: (await unauthenticated.admin(shopDomain)).admin }
      : {};
  const res = await undoAction(shopId, auditId, supabase, deps);
  ...existing v_audit_view re-read...
}
```

`shopDomain` is the string `calderynClient(shopDomain)` was constructed with — use whatever local name that closure variable has. Import `unauthenticated` lazily (`await import("~/shopify.server")`) if a top-level import creates a require cycle; check `npm run build` output.

- [ ] **Step 4: Run all affected suites**

```bash
npx vitest run app/lib/actions/__tests__/ app/lib/dashboard/__tests__/api-write-routes.test.ts && npm run typecheck
```

Expected: PASS (the existing undo-route tests mock `undoAction`, so the new param is transparent; fix any signature drift in mocks rather than production code).

- [ ] **Step 5: Commit**

```bash
git add app/lib/actions/undo.server.ts app/routes/dashboard.api.audit.\$id.undo.tsx app/lib/calderyn.server.ts app/lib/actions/__tests__/undo-inventory.test.ts
git commit -m "actions/undo: support reallocate_inventory via reverse Shopify transfer

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Extension — route action on `app.skus.tsx` (TDD)

**Files:**
- Modify: `app/routes/app.skus.tsx` (add `action`; loader gains `locations`)
- Test: `app/routes/__tests__/skus-action.test.ts`

- [ ] **Step 1: Write the failing route-action tests** (mock style copied from the sibling suites in `app/routes/__tests__/`):

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { action } from "../app.skus";

const authenticateAdmin = vi.fn();
vi.mock("../../shopify.server", () => ({
  authenticate: { admin: (...a: unknown[]) => authenticateAdmin(...a) },
}));
const executeInventoryRelocation = vi.fn();
vi.mock("../../lib/actions/inventory-relocate.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/actions/inventory-relocate.server")>()),
  executeInventoryRelocation: (...a: unknown[]) => executeInventoryRelocation(...a),
}));
vi.mock("../../lib/supabase.server", () => ({
  getSupabase: () => ({ mocked: true }),
  resolveShopId: vi.fn(async () => "shop-1"),
}));
// calderynClient is only used by the loader; keep the action test focused.
vi.mock("../../lib/calderyn.server", () => ({ calderynClient: vi.fn() }));

function postForm(fields: Record<string, string>) {
  const body = new URLSearchParams(fields);
  return new Request("https://app.example/app/skus", { method: "POST", body });
}

const FIELDS = {
  sku_id: "sku-1",
  from_location_id: "gid://shopify/Location/9",
  to_location_id: "gid://shopify/Location/2",
  quantity: "40",
  idempotency_key: "idem-1",
};

beforeEach(() => {
  vi.clearAllMocks();
  authenticateAdmin.mockResolvedValue({
    session: { shop: "s.myshopify.com" },
    admin: { graphql: vi.fn() },
  });
  executeInventoryRelocation.mockResolvedValue({ id: "audit-1", outcome: "succeeded" });
});

describe("app.skus action", () => {
  it("executes the relocation with form-derived input and returns ok", async () => {
    const res = await action({ request: postForm(FIELDS), params: {}, context: {} } as never);
    const body = await (res as Response).json();
    expect(body.ok).toBe(true);
    expect(executeInventoryRelocation).toHaveBeenCalledWith(
      "shop-1",
      expect.objectContaining({
        alertId: null,
        skuId: "sku-1",
        fromLocationId: "gid://shopify/Location/9",
        toLocationId: "gid://shopify/Location/2",
        quantity: 40,
        idempotencyKey: "idem-1",
      }),
      expect.anything(),
      expect.anything(),
    );
  });

  it("rejects a non-integer quantity at the boundary without touching the executor", async () => {
    const res = await action({
      request: postForm({ ...FIELDS, quantity: "1.5" }),
      params: {},
      context: {},
    } as never);
    expect((res as Response).status).toBe(422);
    expect(executeInventoryRelocation).not.toHaveBeenCalled();
  });

  it("maps RelocationError to a 422 with its code and an error toast", async () => {
    const { RelocationError } = await vi.importActual<
      typeof import("../../lib/actions/inventory-relocate.server")
    >("../../lib/actions/inventory-relocate.server");
    executeInventoryRelocation.mockRejectedValue(
      new RelocationError("QTY_EXCEEDS_AVAILABLE", "Only 39 units available at NY."),
    );
    const res = await action({ request: postForm(FIELDS), params: {}, context: {} } as never);
    const body = await (res as Response).json();
    expect((res as Response).status).toBe(422);
    expect(body.error.code).toBe("QTY_EXCEEDS_AVAILABLE");
    expect(body.toast.isError).toBe(true);
  });

  it("surfaces a failed outcome as an error toast, not a success", async () => {
    executeInventoryRelocation.mockResolvedValue({ id: "audit-1", outcome: "failed" });
    const res = await action({ request: postForm(FIELDS), params: {}, context: {} } as never);
    const body = await (res as Response).json();
    expect(body.ok).toBe(false);
    expect(body.toast.isError).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run app/routes/__tests__/skus-action.test.ts`. Expected: FAIL (`action` not exported).

- [ ] **Step 3: Implement the action** in `app.skus.tsx`:

```ts
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import {
  executeInventoryRelocation,
  RelocationError,
} from "~/lib/actions/inventory-relocate.server";
import { getSupabase, resolveShopId } from "~/lib/supabase.server";
import type { ActionToast } from "~/lib/toast";

type RelocatePayload = ActionToast & {
  error?: { code: string; message: string };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const formData = await request.formData();

  // Boundary validation — never trust the modal's FormData (repo rule).
  const skuId = String(formData.get("sku_id") ?? "").trim();
  const fromLocationId = String(formData.get("from_location_id") ?? "").trim();
  const toLocationId = String(formData.get("to_location_id") ?? "").trim();
  const qtyRaw = String(formData.get("quantity") ?? "").trim();
  const idempotencyKey = String(formData.get("idempotency_key") ?? "").trim();
  if (!skuId || !fromLocationId || !toLocationId || !idempotencyKey || !/^\d+$/.test(qtyRaw)) {
    return json<RelocatePayload>(
      {
        ok: false,
        error: { code: "INVALID_INPUT", message: "Quantity must be a positive whole number." },
        toast: { message: "Quantity must be a positive whole number.", isError: true },
      },
      { status: 422 },
    );
  }

  try {
    const shopId = await resolveShopId(session.shop);
    const result = await executeInventoryRelocation(
      shopId,
      {
        alertId: null,
        skuId,
        fromLocationId,
        toLocationId,
        quantity: Number(qtyRaw),
        idempotencyKey,
      },
      getSupabase(),
      admin,
    );
    const ok = result.outcome === "succeeded";
    return json<RelocatePayload>({
      ok,
      toast: ok
        ? { message: "Inventory transfer executed — see the audit log" }
        : { message: "Transfer recorded as failed — check the audit log", isError: true },
    });
  } catch (err) {
    if (err instanceof RelocationError) {
      return json<RelocatePayload>(
        {
          ok: false,
          error: { code: err.code, message: err.message },
          toast: { message: err.message, isError: true },
        },
        { status: 422 },
      );
    }
    const message = err instanceof Error ? err.message : "Inventory transfer failed.";
    return json<RelocatePayload>(
      { ok: false, error: { code: "ACTION_FAILED", message }, toast: { message, isError: true } },
      { status: 500 },
    );
  }
};
```

Also extend the loader's `Promise.all` with `client.locations.list(request.signal)` and add `locations: ShopLocation[]` to `LoaderPayload` (empty array in the error fallback).

- [ ] **Step 4: Run to verify pass** — `npx vitest run app/routes/__tests__/skus-action.test.ts && npm run typecheck`. Expected: PASS, exit 0.

- [ ] **Step 5: Commit**

```bash
git add app/routes/app.skus.tsx app/routes/__tests__/skus-action.test.ts
git commit -m "routes/app.skus: relocation action — boundary validation + executeInventoryRelocation

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Extension — demand column + Relocate modal UI

**Files:**
- Modify: `app/routes/app.skus.tsx`

No new unit tests (presentation; derivation and action are covered). Verification is visual + typecheck.

- [ ] **Step 1: Add the "Main demand" column.** In the table head, between the `Locations` columnheader and `Alerts`:

```tsx
<div role="columnheader" className="cdn-skutable__cell">Main demand</div>
<div role="columnheader" className="cdn-skutable__cell">Actions</div>
```

In each row, after the `LocationCell` cell:

```tsx
<div className="cdn-skutable__cell" role="cell">
  <DemandCell demand={s.demand} />
</div>
<div className="cdn-skutable__cell" role="cell">
  {s.suggested_transfer && (
    <Button size="slim" onClick={() => setRelocating(s)}>
      Relocate
    </Button>
  )}
</div>
```

with the cell component (mirrors `LocationCell`'s tone conventions; "—" for no-sales SKUs matches the days-of-cover treatment):

```tsx
function DemandCell({ demand }: { demand: SKU["demand"] }) {
  if (!demand) {
    return (
      <Text as="span" tone="subdued" variant="bodySm">—</Text>
    );
  }
  const starved = demand.stock_in_region === 0;
  return (
    <span title={`${demand.units_30d.toLocaleString()} units sold in ${demand.region} over 30 days (${Math.round(demand.share * 100)}% of demand) · ${demand.stock_in_region.toLocaleString()} in stock there`}>
      <Text as="span" variant="bodySm" fontWeight={starved ? "semibold" : "medium"} tone={starved ? "critical" : undefined}>
        {shortLoc(demand.region)}
      </Text>{" "}
      <Text as="span" variant="bodySm" tone="subdued">
        <span className="cdn-tnum">{demand.units_30d.toLocaleString()}</span>/30d
      </Text>
    </span>
  );
}
```

(`Button` added to the Polaris imports; `setRelocating` state added in Step 2. Update the `cdn-skutable` grid CSS for the two extra columns if the class defines `grid-template-columns` — find it with `grep -rn "cdn-skutable" app/` and extend the template by ` minmax(110px, 1fr) 88px`.)

- [ ] **Step 2: Add the modal.** State + wiring in `SKUs()`:

```tsx
const [relocating, setRelocating] = useState<SKU | null>(null);
const fetcher = useFetcher<RelocatePayload>();
useActionToast(fetcher.data);
useEffect(() => {
  if (fetcher.data?.ok) setRelocating(null);
}, [fetcher.data]);
```

```tsx
{relocating && (
  <RelocateModal
    sku={relocating}
    locations={locations}
    fetcher={fetcher}
    onClose={() => setRelocating(null)}
  />
)}
```

The modal (prefilled from `suggested_transfer`, editable; one stable idempotency key per open — same idea as `useStableIdempotencyKey` in `app.alerts.$id.tsx:482`):

```tsx
function RelocateModal({
  sku,
  locations,
  fetcher,
  onClose,
}: {
  sku: SKU;
  locations: ShopLocation[];
  fetcher: ReturnType<typeof useFetcher<RelocatePayload>>;
  onClose: () => void;
}) {
  const plan = sku.suggested_transfer!;
  const [fromId, setFromId] = useState(plan.from_location_id);
  const [toId, setToId] = useState(plan.to_location_id);
  const [qty, setQty] = useState(String(plan.recommended_delta));
  // One key per modal-open: double-clicking Confirm replays, not re-executes.
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  const sourceOptions = sku.locations_detail
    .filter((l) => l.available > 0)
    .map((l) => ({ label: `${l.name} (${l.available.toLocaleString()} available)`, value: l.id }));
  const destOptions = locations
    .filter((l) => l.active)
    .map((l) => ({ label: l.region ? `${l.name} — ${l.region}` : l.name, value: l.id }));

  const available = sku.locations_detail.find((l) => l.id === fromId)?.available ?? 0;
  const qtyNum = /^\d+$/.test(qty) ? Number(qty) : NaN;
  const qtyError = !Number.isInteger(qtyNum) || qtyNum < 1
    ? "Enter a positive whole number"
    : qtyNum > available
      ? `Only ${available.toLocaleString()} available at the source`
      : undefined;
  const invalid = Boolean(qtyError) || fromId === toId;
  const submitting = fetcher.state !== "idle";

  const submit = () => {
    fetcher.submit(
      {
        sku_id: sku.id,
        from_location_id: fromId,
        to_location_id: toId,
        quantity: qty,
        idempotency_key: idempotencyKey,
      },
      { method: "post" },
    );
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Relocate ${sku.title}`}
      primaryAction={{
        content: "Move inventory",
        onAction: submit,
        loading: submitting,
        disabled: invalid,
      }}
      secondaryActions={[{ content: "Cancel", onAction: onClose }]}
    >
      <Modal.Section>
        <BlockStack gap="400">
          {sku.demand && (
            <Text as="p" tone="subdued">
              Main demand is {sku.demand.region} ({sku.demand.units_30d.toLocaleString()} units/30d),
              which currently holds {sku.demand.stock_in_region.toLocaleString()} units.
            </Text>
          )}
          <Select label="From" options={sourceOptions} value={fromId} onChange={setFromId} />
          <Select
            label="To"
            options={destOptions}
            value={toId}
            onChange={setToId}
            error={fromId === toId ? "Source and destination must differ" : undefined}
          />
          <TextField
            label="Quantity"
            type="text"
            autoComplete="off"
            value={qty}
            onChange={setQty}
            error={qtyError}
            helpText="Suggested to cover one week of regional demand."
          />
          <Text as="p" tone="subdued" variant="bodySm">
            Transfers via Shopify, recorded in the audit log. Reversible via Undo for 24 hours.
          </Text>
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}
```

Polaris imports to add: `BlockStack`, `Button`, `Modal`, `Select`; Remix: `useFetcher`; React: `useEffect`; plus `useActionToast` from `~/lib/toast` and `ShopLocation` from `~/lib/types`.

- [ ] **Step 3: Verify**

```bash
npm run typecheck && npm run lint && npx vitest run app/routes/__tests__/skus-action.test.ts
```

Expected: all exit 0. Then visual check (`npm run dev` + the embedded app, or the seeded dev store): demand column renders, no-sales SKUs show "—", a mismatched SKU shows Relocate, modal prefilled, qty > available disables submit.

- [ ] **Step 4: Commit**

```bash
git add app/routes/app.skus.tsx
git commit -m "routes/app.skus: main-demand column + prefilled editable Relocate modal

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Dashboard — relocate API route (TDD)

**Files:**
- Create: `app/routes/dashboard.api.skus.$id.relocate.tsx`
- Test: `app/lib/dashboard/__tests__/skus-relocate-route.test.ts`

- [ ] **Step 1: Write the failing tests** (vi.mock harness copied from `api-write-routes.test.ts`):

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { action } from "../../../routes/dashboard.api.skus.$id.relocate";

const requireDashboardSession = vi.fn();
const requireSameOrigin = vi.fn();
const executeInventoryRelocation = vi.fn();
const unauthenticatedAdmin = vi.fn();

vi.mock("../session.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../session.server")>()),
  requireDashboardSession: (...a: unknown[]) => requireDashboardSession(...a),
}));
vi.mock("../http.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../http.server")>()),
  requireSameOrigin: (...a: unknown[]) => requireSameOrigin(...a),
}));
vi.mock("../../actions/inventory-relocate.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../actions/inventory-relocate.server")>()),
  executeInventoryRelocation: (...a: unknown[]) => executeInventoryRelocation(...a),
}));
vi.mock("../../supabase.server", () => ({ getSupabase: () => ({ mocked: true }) }));
vi.mock("../../../shopify.server", () => ({
  unauthenticated: { admin: (...a: unknown[]) => unauthenticatedAdmin(...a) },
}));

function post(body: unknown) {
  return new Request("https://app.example/dashboard/api/skus/sku-1/relocate", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const BODY = {
  from_location_id: "gid://shopify/Location/9",
  to_location_id: "gid://shopify/Location/2",
  quantity: 40,
  idempotency_key: "idem-1",
};

beforeEach(() => {
  vi.clearAllMocks();
  requireDashboardSession.mockResolvedValue({
    shopId: "shop-1",
    shopDomain: "s.myshopify.com",
  });
  unauthenticatedAdmin.mockResolvedValue({ admin: { graphql: vi.fn() } });
  executeInventoryRelocation.mockResolvedValue({ id: "audit-1", outcome: "succeeded" });
});

describe("dashboard.api.skus.$id.relocate", () => {
  it("executes with session-derived shop and route-param sku", async () => {
    const res = await action({ request: post(BODY), params: { id: "sku-1" }, context: {} } as never);
    const body = await (res as Response).json();
    expect(body).toMatchObject({ audit_id: "audit-1", outcome: "succeeded" });
    expect(executeInventoryRelocation).toHaveBeenCalledWith(
      "shop-1",
      expect.objectContaining({ skuId: "sku-1", quantity: 40, idempotencyKey: "idem-1" }),
      expect.anything(),
      expect.anything(),
    );
  });

  it("rejects non-POST", async () => {
    const res = await action({
      request: new Request("https://x/", { method: "GET" }),
      params: { id: "sku-1" },
      context: {},
    } as never);
    expect((res as Response).status).toBe(405);
  });

  it("422s on a missing idempotency key or bad quantity without executing", async () => {
    for (const bad of [{ ...BODY, idempotency_key: "" }, { ...BODY, quantity: 0 }]) {
      const res = await action({ request: post(bad), params: { id: "sku-1" }, context: {} } as never);
      expect((res as Response).status).toBe(422);
    }
    expect(executeInventoryRelocation).not.toHaveBeenCalled();
  });

  it("maps RelocationError to its code/status", async () => {
    const { RelocationError } = await vi.importActual<
      typeof import("../../actions/inventory-relocate.server")
    >("../../actions/inventory-relocate.server");
    executeInventoryRelocation.mockRejectedValue(
      new RelocationError("QTY_EXCEEDS_AVAILABLE", "Only 5 units available."),
    );
    const res = await action({ request: post(BODY), params: { id: "sku-1" }, context: {} } as never);
    expect((res as Response).status).toBe(422);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run app/lib/dashboard/__tests__/skus-relocate-route.test.ts`. Expected: FAIL (route module missing).

- [ ] **Step 3: Implement the route** (template: `dashboard.api.alerts.$id.action.tsx`):

```tsx
// POST /dashboard/api/skus/:id/relocate
// { from_location_id, to_location_id, quantity, idempotency_key } →
// merchant-initiated inventory transfer. Dashboard mirror of the relocate
// action on app.skus.tsx: the inventory item and ownership checks are
// re-derived server-side by executeInventoryRelocation, never trusted from
// the request body.

import type { ActionFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import { CalderynError } from "~/lib/calderyn.server";
import { unauthenticated } from "~/shopify.server";
import {
  executeInventoryRelocation,
  RelocationError,
} from "~/lib/actions/inventory-relocate.server";
import { getSupabase } from "~/lib/supabase.server";

export async function action({ request, params }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonError(422, "invalid_json");
  }

  const fromLocationId = String(body.from_location_id ?? "");
  const toLocationId = String(body.to_location_id ?? "");
  const quantity = Number(body.quantity);
  const idempotencyKey = String(body.idempotency_key ?? "");
  if (!idempotencyKey) return jsonError(422, "missing_idempotency_key");
  if (!fromLocationId || !toLocationId) return jsonError(422, "missing_location");
  if (!Number.isInteger(quantity) || quantity <= 0) return jsonError(422, "invalid_quantity");

  const skuId = String(params.id);

  return dashboardJson(async () => {
    const { admin } = await unauthenticated.admin(session.shopDomain);
    try {
      const result = await executeInventoryRelocation(
        session.shopId,
        { alertId: null, skuId, fromLocationId, toLocationId, quantity, idempotencyKey },
        getSupabase(),
        admin,
      );
      return { audit_id: result.id, outcome: result.outcome };
    } catch (err) {
      if (err instanceof RelocationError) {
        throw new CalderynError({ code: err.code.toLowerCase(), status: 422, message: err.message });
      }
      throw err;
    }
  });
}
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run app/lib/dashboard/__tests__/skus-relocate-route.test.ts && npm run typecheck`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/routes/dashboard.api.skus.\$id.relocate.tsx app/lib/dashboard/__tests__/skus-relocate-route.test.ts
git commit -m "routes/dashboard.api.skus.\$id.relocate: merchant inventory transfer endpoint

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: Dashboard — view-model, client wrapper, Inventory screen UI

**Files:**
- Modify: `app/components/dashboard/view-models.ts` (`SkuVM`, line 62)
- Modify: `app/lib/dashboard/client.ts` (`adaptSku` line 256, new `relocateSku`)
- Modify: `app/components/dashboard/screens/Inventory.tsx`
- Test: extend the existing adapt tests in `app/components/dashboard/__tests__/` or `app/lib/dashboard/__tests__/` (place beside `adapt-alert.test.ts`)

- [ ] **Step 1: Extend `SkuVM`** — append to the interface:

```ts
demand: { region: string; units_30d: number; share: number; stock_in_region: number } | null;
suggested_transfer: {
  from_location_id: string;
  from_location_name: string;
  to_location_id: string;
  to_location_name: string;
  recommended_delta: number;
} | null;
locations_detail: Array<{ id: string; name: string; region: string | null; available: number }>;
```

- [ ] **Step 2: Write the failing adapt test** (beside `adapt-alert.test.ts`, same import style):

```ts
import { describe, it, expect } from "vitest";
import { adaptSku } from "../client";

const BASE = {
  id: "sku-1",
  title: "Widget",
  on_hand: 85,
  days_of_cover: 4,
  velocity: 10,
  locations: { NY: 80, LA: 5 },
  sources: [],
  demand: { region: "CA", units_30d: 300, share: 0.75, stock_in_region: 5 },
  suggested_transfer: {
    inventory_item_id: "gid://shopify/InventoryItem/1",
    from_location_id: "gid://shopify/Location/9",
    from_location_name: "NY",
    to_location_id: "gid://shopify/Location/2",
    to_location_name: "LA",
    recommended_delta: 65,
  },
  locations_detail: [
    { id: "gid://shopify/Location/9", name: "NY", region: "NY", available: 80 },
  ],
};

describe("adaptSku demand passthrough", () => {
  it("carries demand, suggestion, and location detail into the VM", () => {
    const vm = adaptSku(BASE as never);
    expect(vm.demand?.region).toBe("CA");
    expect(vm.suggested_transfer?.recommended_delta).toBe(65);
    expect(vm.locations_detail).toHaveLength(1);
  });

  it("defaults to null/empty when the API omits the fields (older payloads)", () => {
    const vm = adaptSku({ ...BASE, demand: undefined, suggested_transfer: undefined, locations_detail: undefined } as never);
    expect(vm.demand).toBeNull();
    expect(vm.suggested_transfer).toBeNull();
    expect(vm.locations_detail).toEqual([]);
  });
});
```

Run: `npx vitest run <new test file>` — expected FAIL.

- [ ] **Step 3: Implement.** In `adaptSku` add:

```ts
demand: s.demand ?? null,
suggested_transfer: s.suggested_transfer ?? null,
locations_detail: s.locations_detail ?? [],
```

Add the client wrapper beside `executeAlertAction` (line 479):

```ts
export async function relocateSku(
  skuId: string,
  input: { fromLocationId: string; toLocationId: string; quantity: number },
): Promise<{ auditId: string; outcome: string }> {
  const data = await apiSend<{ audit_id: string; outcome: string }>(
    "POST",
    `/dashboard/api/skus/${encodeURIComponent(skuId)}/relocate`,
    {
      from_location_id: input.fromLocationId,
      to_location_id: input.toLocationId,
      quantity: input.quantity,
      idempotency_key: crypto.randomUUID(),
    },
  );
  return { auditId: data.audit_id, outcome: data.outcome };
}
```

- [ ] **Step 4: Inventory screen.** In `Inventory.tsx` (mirror, not port — dashboard primitives only):

1. New columns in `cd-table-head` after `By location`:

```tsx
<span style={{ width: 120 }}>Main demand</span>
<span style={{ width: 84 }}></span>
```

2. In each row after the `LocationBar` span:

```tsx
<span style={{ width: 120 }}>
  {s.demand ? (
    <span
      className="cd-caption tabular-nums"
      title={`${s.demand.units_30d} units/30d in ${s.demand.region} · ${s.demand.stock_in_region} in stock there`}
      style={{ color: s.demand.stock_in_region === 0 ? "var(--red)" : "var(--text-2)" }}
    >
      {s.demand.region} · {s.demand.units_30d}/30d
    </span>
  ) : (
    <span className="cd-caption">—</span>
  )}
</span>
<span style={{ width: 84, display: "flex", justifyContent: "flex-end" }}>
  {s.suggested_transfer && (
    <Btn
      small
      onClick={(e: React.MouseEvent) => {
        e.stopPropagation(); // row click navigates to a linked alert
        setRelocating(s);
      }}
    >
      Relocate
    </Btn>
  )}
</span>
```

3. Dialog state + execution (the dashboard has no modal primitive — use the same fixed-overlay pattern as other inline panels, `Card` + `Btn`, with `app.toast` + `app.refresh` on success):

```tsx
const [relocating, setRelocating] = useState<SkuVM | null>(null);
const [busy, setBusy] = useState(false);

async function confirmRelocate(skuId: string, fromId: string, toId: string, qty: number) {
  setBusy(true);
  try {
    const { outcome } = await relocateSku(skuId, {
      fromLocationId: fromId,
      toLocationId: toId,
      quantity: qty,
    });
    if (outcome === "succeeded") {
      app.toast("Inventory transfer executed", "box", "success");
      setRelocating(null);
      app.refresh();
    } else {
      app.toast("Transfer recorded as failed — check the audit log", "warn", "critical");
    }
  } catch (err) {
    app.toast(
      err instanceof DashboardApiError ? err.message : "Couldn't move inventory.",
      "warn",
      "critical",
    );
  } finally {
    setBusy(false);
  }
}
```

and a `RelocateDialog` component rendered when `relocating` is set: source `<select>` over `relocating.locations_detail` (available > 0), destination `<select>` over the union of `locations_detail` entries plus the suggested destination (the dashboard API exposes no shop-locations endpoint; the suggested destination is always present when the button is, and per-SKU holders cover the manual-edit case), quantity `<input inputMode="numeric">` prefilled with `recommended_delta`, client-side disable when qty ≤ 0, qty > source availability, or from === to, and a caption: "Recorded in the audit log. Reversible via Undo for 24 hours." Use native `<select>`/`<input>` styled with the existing `cd-*` form classes (`grep -rn "cd-input\|<select" app/components/dashboard/` and reuse whatever Settings.tsx uses for its form controls).

- [ ] **Step 5: Verify**

```bash
npx vitest run app/lib/dashboard/__tests__/ app/components/dashboard/__tests__/ && npm run typecheck && npm run lint && npm run build
```

Expected: all green. Visual check on the dashboard (`/dashboard` route in dev) mirrors Task 8's checks.

- [ ] **Step 6: Commit**

```bash
git add app/components/dashboard/view-models.ts app/lib/dashboard/client.ts app/components/dashboard/screens/Inventory.tsx <new test file>
git commit -m "dashboard: inventory demand column + relocate dialog wired to relocate endpoint

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: Full gate + wrap-up

- [ ] **Step 1: Run the repo pre-commit gate in order** (CLAUDE.md — paste outputs, no assertions without evidence):

```bash
npm run typecheck        # exit 0
npm run lint             # exit 0, no warnings on touched files
npm run build            # exit 0
npm test                 # full vitest suite
TEST_DATABASE_URL=postgres://postgres:test@localhost:5432/calderyn_test \
  python -m pytest tests/engine -v   # engine suite incl. the new view tests
```

- [ ] **Step 2: `/code-review`** on the working tree; resolve every blocker; downgrade nits explicitly.

- [ ] **Step 3: Patch sanity**

```bash
git diff main --stat && git diff main --check
git diff main | grep -nE "console\.log|\.only\(|TODO\(me\)" || echo clean
```

- [ ] **Step 4: Update the knowledge graph**

```bash
graphify update .
```

- [ ] **Step 5: Stop.** Do not push or open a PR automatically (repo rule) — report the branch (`feat/inventory-relocation`), the commits, and the gate outputs, and wait for the user. After merge: `git worktree remove .claude/worktrees/inventory-relocation` and delete the branch.

---

## Plan self-review notes

- **Spec coverage:** data layer → Tasks 2–4; shared executor → Task 5; undo → Task 6 (also closes the surfaced pre-existing gap); extension UI/action → Tasks 7–8; dashboard mirror → Tasks 9–10; error codes (`INVALID_TRANSFER_PLAN`, `SAME_LOCATION`, `QTY_EXCEEDS_AVAILABLE`) → Task 5; fresh-availability re-check → Task 5; view fixture test → Task 2; alert-route refactor proof: the alert routes were **not** refactored after all — the executor is new code and the alert paths keep their existing inline flow, so no refactor risk exists (deliberate narrowing vs the spec's "extract" wording: extraction would have forced the alert routes onto a new code path with no behavior change to buy; the spec's real requirement — one shared execution contract — is met by matching the audit params shape exactly).
- **Guardrail note:** the spec's "guardrail check" maps to the existing merchant-action model: alert-driven actions check `dollar_impact` against the per-action cap; a manual transfer claims no dollar impact, so the cap check is vacuous and is intentionally omitted rather than faked. `checkGuardrails` (autopilot) requires a campaign UUID and does not apply.
- **Type consistency check:** `SuggestedTransfer.from_location_id`/`to_location_id` (DTO) ↔ executor input `fromLocationId/toLocationId` ↔ route body `from_location_id/to_location_id` — names verified across Tasks 3, 5, 7, 9, 10.
