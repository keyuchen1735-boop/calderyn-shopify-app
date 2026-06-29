# Import from Shopify (Mirror → Owned Promote) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-merchant, re-runnable "Import from Shopify" that pulls 12 months of their store data into the warehouse (reusing `backfillShop`) and promotes catalog + inventory into the owned tables, with an honest report — running off the request as a background job tracked by an `import_run` row.

**Architecture:** The import is a small state machine on a new `import_run` row (`pulling → promoting → done/error`). Starting it sets the row + flags the shop for the background drain; an extended ingest cron pulls 12 months via a **parameterized** `backfillShop`, then calls a per-shop `promote_shop_from_mirror(shop_id)` SQL function (the Slice 1 catalog backfill + Slice 2 inventory seed, scoped to one shop, idempotent). The dashboard shows a button → progress (polling the row) → an honest report.

**Tech Stack:** Postgres (Supabase) migration + plpgsql, `@supabase/supabase-js`, the existing ingest backfill/cron, Remix dashboard route + SPA screen, vitest.

## Global Constraints

- TypeScript only; `tsc --noEmit` authoritative; no `any` without written justification.
- Reuse the existing pull (`backfillShop`) and cron-drain pattern (`shop_integrations.sync_status` + `/cron/ingest`); do not write a second Shopify fetcher.
- Promote is **idempotent**: key on `external_id`, `on conflict do nothing`/update. A second import must not duplicate (re-run test required).
- Promote preserves the Slice 1 invariant `variant_dim.id == sku_dim.id` and runs **catalog before** inventory, so order lines resolve.
- The report copy **always names** the exclusions (customers, store design); it is fixed text, not free-form.
- Migrations in BOTH `supabase/migrations/` and `tests/engine/schema/migrations/`.
- Depends on Slice 1 (owned catalog tables + backfill SQL) and Slice 2 (`inventory_balance`) being built first.
- Pre-commit gate: `npm run typecheck` → `npm run lint` → `npm run build` (exit 0); `npx vitest run` green.

---

### Task 1: Parameterize the order window in `backfillShop`

**Files:**
- Modify: `app/lib/ingest/backfill.server.ts`
- Test: `app/lib/ingest/__tests__/backfill-window.test.ts`

**Interfaces:**
- Produces: `backfillShop(shopDomain: string, opts?: { sinceDays?: number }): Promise<BackfillResult>` — `sinceDays` defaults to 30 (install behavior unchanged); the import passes 365.

- [ ] **Step 1: Write the failing test** (assert the orders `since` reflects `sinceDays`)

```typescript
import { describe, it, expect, vi } from "vitest";
const fetchRecentOrders = vi.fn(async function* () {});
vi.mock("../shopify-admin.server", () => ({
  fetchLocations: vi.fn(async () => []),
  fetchProducts: vi.fn(async function* () {}),
  fetchRecentOrders,
}));
vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => ({ from: () => ({ upsert: () => ({ select: () => Promise.resolve({ data: [], error: null }) }), update: () => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) }), select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) }) }), resolveShopId: vi.fn(async () => "shop1") }));

describe("backfillShop window", () => {
  it("passes a 365-day-ago since when sinceDays=365", async () => {
    const { backfillShop } = await import("../backfill.server");
    await backfillShop("d.myshopify.com", { sinceDays: 365 });
    const since = new Date(fetchRecentOrders.mock.calls[0][1]).getTime();
    const days = (Date.now() - since) / 86_400_000;
    expect(days).toBeGreaterThan(360);
    expect(days).toBeLessThan(370);
  });
});
```

- [ ] **Step 2: Run → fail.** `npx vitest run app/lib/ingest/__tests__/backfill-window.test.ts` (FAIL: `backfillShop` takes one arg).

- [ ] **Step 3: Parameterize.** Change the signature + the orders `since`:

```typescript
const DEFAULT_BACKFILL_DAYS = 30;
// ...
export async function backfillShop(shopDomain: string, opts: { sinceDays?: number } = {}): Promise<BackfillResult> {
  const sinceDays = opts.sinceDays ?? DEFAULT_BACKFILL_DAYS;
  // ...
  // 3. Orders (last `sinceDays` days)
  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString();
```
(Remove the old `BACKFILL_DAYS` const usage; `afterAuth` still calls `backfillShop(shop)` → defaults to 30.)

- [ ] **Step 4: Run → pass.** Commit.

```bash
git add app/lib/ingest/backfill.server.ts app/lib/ingest/__tests__/backfill-window.test.ts
git commit -m "feat(import): parameterize backfill order window (default 30)"
```

---

### Task 2: `import_run` table

**Files:**
- Create: `supabase/migrations/20260629130000_import_run.sql` (+ engine copy)

**Interfaces:**
- Produces: `import_run(id uuid pk, shop_id, state text check(pulling|promoting|done|error), since_days int, counts jsonb, report jsonb, error text, started_at, finished_at)`.

- [ ] **Step 1: Write the migration**

```sql
create table if not exists public.import_run (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  state text not null check (state in ('pulling','promoting','done','error')),
  since_days int not null default 365,
  counts jsonb not null default '{}'::jsonb,
  report jsonb,
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists import_run_shop_idx on public.import_run(shop_id, started_at desc);
alter table public.import_run enable row level security;
```

- [ ] **Step 2: Apply locally + verify** (`psql -f`; `\d import_run`). **Commit.**

```bash
git add supabase/migrations/20260629130000_import_run.sql tests/engine/schema/migrations/20260629130000_import_run.sql
git commit -m "feat(import): import_run state table"
```

---

### Task 3: `promote_shop_from_mirror(shop_id)` SQL function

**Files:**
- Create: `supabase/migrations/20260629130100_promote_shop_fn.sql` (+ engine copy)

**Interfaces:**
- Produces: `promote_shop_from_mirror(p_shop_id uuid) returns jsonb` — promotes this shop's `sku_dim` → `product_dim`/`variant_dim` (+ options? no — facets only), collections, and seeds `inventory_balance` from the latest `inventory_level_fact` per (variant, location). Idempotent. Returns `{products, variants, collections, balances}` counts.

- [ ] **Step 1: Write the function** (the Slice 1 backfill SQL + Slice 2 seed, scoped to one shop)

```sql
create or replace function public.promote_shop_from_mirror(p_shop_id uuid) returns jsonb
language plpgsql as $$
declare c_products int; c_variants int; c_collections int; c_balances int;
begin
  -- Products (one per shop+product GID); product-level attrs from any variant row.
  insert into public.product_dim (shop_id, external_id, handle, title, status, vendor, category, tags, created_at, updated_at)
  select distinct on (s.shop_id, s.product_id)
    s.shop_id, s.product_id, 'p-' || substr(md5(s.shop_id::text || ':' || s.product_id), 1, 16),
    s.title, case when s.product_status in ('draft','active','archived') then s.product_status else 'active' end,
    s.vendor, s.category, s.tags, s.created_at, s.updated_at
  from public.sku_dim s where s.shop_id = p_shop_id
  order by s.shop_id, s.product_id, s.created_at
  on conflict (shop_id, external_id) where (external_id is not null) do nothing;

  -- Variants (id PRESERVED: variant_dim.id == sku_dim.id).
  insert into public.variant_dim (id, shop_id, product_id, external_id, inventory_item_id, sku, title, price_tier, retail_price_cents, unit_cost_cents, currency, grams, inventory_policy, inventory_tracked, inventory_on_hand, created_at, updated_at)
  select s.id, s.shop_id, p.id, s.external_id, s.inventory_item_id, s.sku, s.title, s.price_tier, s.retail_price_cents, s.unit_cost_cents, s.currency, s.grams, s.inventory_policy, s.inventory_tracked, 0, s.created_at, s.updated_at
  from public.sku_dim s join public.product_dim p on p.shop_id = s.shop_id and p.external_id = s.product_id
  where s.shop_id = p_shop_id
  on conflict (id) do nothing;

  -- Collections from the text[] arrays + links.
  insert into public.collection_dim (shop_id, handle, title)
  select distinct s.shop_id, substr(regexp_replace(lower(c.name), '[^a-z0-9]+', '-', 'g'), 1, 60), c.name
  from public.sku_dim s cross join lateral unnest(s.collections) as c(name)
  where s.shop_id = p_shop_id and c.name is not null and length(trim(c.name)) > 0
  on conflict (shop_id, handle) do nothing;
  insert into public.product_collection (product_id, collection_id)
  select distinct p.id, col.id
  from public.sku_dim s
  join public.product_dim p on p.shop_id = s.shop_id and p.external_id = s.product_id
  cross join lateral unnest(s.collections) as c(name)
  join public.collection_dim col on col.shop_id = s.shop_id and col.title = c.name
  where s.shop_id = p_shop_id and c.name is not null and length(trim(c.name)) > 0
  on conflict (product_id, collection_id) do nothing;

  -- Inventory: seed inventory_balance from the LATEST observation per (variant, location).
  insert into public.inventory_balance (shop_id, variant_id, location_id, on_hand)
  select distinct on (f.sku_id, f.location_id) f.shop_id, f.sku_id, f.location_id, f.available
  from public.inventory_level_fact f
  where f.shop_id = p_shop_id
  order by f.sku_id, f.location_id, f.observed_at desc
  on conflict (variant_id, location_id) do nothing;

  select count(*) into c_products from public.product_dim where shop_id = p_shop_id;
  select count(*) into c_variants from public.variant_dim where shop_id = p_shop_id;
  select count(*) into c_collections from public.collection_dim where shop_id = p_shop_id;
  select count(*) into c_balances from public.inventory_balance where shop_id = p_shop_id;
  return jsonb_build_object('products', c_products, 'variants', c_variants, 'collections', c_collections, 'balances', c_balances);
end $$;
```

- [ ] **Step 2: Apply + smoke** (seed a sample shop's `sku_dim`+`inventory_level_fact`, call the function, assert counts > 0 and a second call returns the same counts). **Commit.**

```bash
git add supabase/migrations/20260629130100_promote_shop_fn.sql tests/engine/schema/migrations/20260629130100_promote_shop_fn.sql
git commit -m "feat(import): per-shop idempotent promote function"
```

---

### Task 4: TS promote wrapper + honest report

**Files:**
- Create: `app/lib/import/promote.server.ts`
- Test: `app/lib/import/__tests__/promote.server.test.ts`

**Interfaces:**
- Produces:
  - `promoteShopFromMirror(shopId: string): Promise<{ products: number; variants: number; collections: number; balances: number }>` — calls the SQL fn.
  - `buildImportReport(counts, orderCount: number): { imported: string[]; notIncluded: string[] }` — fixed honest copy.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi } from "vitest";
const rpc = vi.fn().mockResolvedValue({ data: { products: 5, variants: 12, collections: 2, balances: 12 }, error: null });
vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => ({ rpc }) }));

describe("promote", () => {
  it("returns the SQL counts", async () => {
    const { promoteShopFromMirror } = await import("../promote.server");
    expect(await promoteShopFromMirror("shop1")).toEqual({ products: 5, variants: 12, collections: 2, balances: 12 });
    expect(rpc).toHaveBeenCalledWith("promote_shop_from_mirror", { p_shop_id: "shop1" });
  });
  it("report always names the exclusions", async () => {
    const { buildImportReport } = await import("../promote.server");
    const r = buildImportReport({ products: 5, variants: 12, collections: 2, balances: 12 }, 1100);
    expect(r.notIncluded.join(" ")).toMatch(/customer/i);
    expect(r.notIncluded.join(" ")).toMatch(/store design|theme/i);
  });
});
```

- [ ] **Step 2: Run → fail. Step 3: Write it.**

```typescript
// app/lib/import/promote.server.ts
import { getSupabase } from "../supabase.server";

export interface PromoteCounts { products: number; variants: number; collections: number; balances: number }

export async function promoteShopFromMirror(shopId: string): Promise<PromoteCounts> {
  const { data, error } = await getSupabase().rpc("promote_shop_from_mirror", { p_shop_id: shopId });
  if (error) throw error;
  return data as PromoteCounts;
}

export function buildImportReport(counts: PromoteCounts, orderCount: number): { imported: string[]; notIncluded: string[] } {
  return {
    imported: [
      `${counts.products} products (${counts.variants} variants)`,
      `${counts.collections} collections`,
      `${counts.balances} stock locations`,
      `${orderCount} past orders (last 12 months)`,
    ],
    notIncluded: [
      "Your customer list — brought over separately, with consent (privacy rules).",
      "Your store design / theme — re-created in Calderyn's builder later.",
    ],
  };
}
```

- [ ] **Step 4: Run → pass. Commit.**

```bash
git add app/lib/import/promote.server.ts app/lib/import/__tests__/promote.server.test.ts
git commit -m "feat(import): promote wrapper + honest report"
```

---

### Task 5: Import orchestrator + background drain

**Files:**
- Create: `app/lib/import/run.server.ts`
- Modify: `app/routes/cron.ingest.tsx` (drain `import_run` rows in `pulling`/`promoting`)
- Test: `app/lib/import/__tests__/run.server.test.ts`

**Interfaces:**
- Produces:
  - `startImport(shopId: string): Promise<{ importId: string }>` — inserts an `import_run` (`state=pulling`, `since_days=365`); the cron does the work.
  - `drainImports(): Promise<{ processed: number }>` — for each `pulling` run: `backfillShop(shopDomain, { sinceDays: 365 })` → set `promoting` → `promoteShopFromMirror` → count orders → `done` + report. Errors set `error`.
  - `latestImport(shopId): Promise<ImportRunVM | null>` — for the UI poll.

- [ ] **Step 1: Write the failing test** (drain happy path; mock backfill + promote)

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
const backfillShop = vi.fn().mockResolvedValue({ orders: 1100 });
vi.mock("~/lib/ingest/backfill.server", () => ({ backfillShop }));
const promote = vi.fn().mockResolvedValue({ products: 5, variants: 12, collections: 2, balances: 12 });
vi.mock("../promote.server", () => ({ promoteShopFromMirror: promote, buildImportReport: () => ({ imported: [], notIncluded: [] }) }));
const update = vi.fn(() => ({ eq: () => Promise.resolve({ error: null }) }));
const pullingRows = [{ id: "r1", shop_id: "shop1", since_days: 365, shop: { shop_domain: "d.myshopify.com" } }];
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({ from: () => ({ select: () => ({ eq: () => Promise.resolve({ data: pullingRows, error: null }) }), update }) }),
}));
beforeEach(() => { backfillShop.mockClear(); promote.mockClear(); });

describe("drainImports", () => {
  it("pulls 365 days then promotes", async () => {
    const { drainImports } = await import("../run.server");
    const r = await drainImports();
    expect(backfillShop).toHaveBeenCalledWith("d.myshopify.com", { sinceDays: 365 });
    expect(promote).toHaveBeenCalledWith("shop1");
    expect(r.processed).toBe(1);
  });
});
```

- [ ] **Step 2: Run → fail. Step 3: Write `run.server.ts`** (start + drain + latest) — the drain loops `pulling` runs, calls `backfillShop(domain,{sinceDays})`, flips to `promoting`, calls `promoteShopFromMirror`, counts orders (`order_fact` for the shop), writes `done` + `buildImportReport(...)`; a thrown error writes `state='error'` + the message. (Resolve `shop_domain` via the joined `shops` row.)

- [ ] **Step 4: Wire the drain into `/cron/ingest`** — after the existing Shopify-backfill drain, call `drainImports()` and include its count in the cron's JSON summary. (Same `isAuthorizedCron` guard; no new cron route needed.)

- [ ] **Step 5: Run → pass. Commit.**

```bash
git add app/lib/import/run.server.ts app/routes/cron.ingest.tsx app/lib/import/__tests__/run.server.test.ts
git commit -m "feat(import): orchestrator + background drain via /cron/ingest"
```

---

### Task 6: Dashboard route + screen (start, poll, report)

**Files:**
- Create: `app/routes/dashboard.api.import.tsx` (GET latest status, POST start)
- Modify: `app/lib/dashboard/client.ts` (`fetchImportStatus`, `startImport`)
- Create: `app/components/dashboard/screens/ImportShopify.tsx` (+ register in `DashboardApp`/`context` like Slice 1 B2)
- Test: `app/routes/__tests__/dashboard.api.import.test.ts`

**Interfaces:**
- Consumes: `requireDashboardSession`, `requireSameOrigin`, `dashboardJson`, `jsonError`; `startImport`, `latestImport`.
- Behavior: POST starts an import for `session.shopId`; GET returns the latest run (state + counts + report). The screen shows a button, polls while `pulling`/`promoting`, then renders the honest report (`imported` + `notIncluded`).

- [ ] **Step 1: Write the failing route test** (POST starts; GET returns latest) — mirrors the Slice 1 catalog route tests.
- [ ] **Step 2: Run → fail. Step 3:** write the route (loader = `latestImport`; action = `requireSameOrigin` + `startImport`), the two client functions (`apiGet`/`apiSend`), and the screen (poll every ~3s while in-progress; render the report; for a fresh/unconnected shop, show "Connect Shopify first" linking the existing connect — the warm-lead path just shows the button).
- [ ] **Step 4: Run → pass; `npm run typecheck && npm run build`. Commit.**

```bash
git add app/routes/dashboard.api.import.tsx app/lib/dashboard/client.ts app/components/dashboard/screens/ImportShopify.tsx app/components/dashboard/context.ts app/components/dashboard/DashboardApp.tsx app/routes/__tests__/dashboard.api.import.test.ts
git commit -m "feat(import): dashboard import screen (start, poll, honest report)"
```

---

### Task 7: Re-run idempotency proof + full gate

**Files:**
- Create: `tests/engine/import/promote-idempotency.test.ts` (DB-backed, `TEST_DATABASE_URL`)

- [ ] **Step 1: Write the DB-backed re-run test** — seed a shop's `sku_dim` + `inventory_level_fact`; call `promote_shop_from_mirror` twice; assert the second call returns the **same counts** (no duplicate products/variants/balances).

```typescript
import { describe, it, expect } from "vitest";
import { Client } from "pg";
const URL = process.env.TEST_DATABASE_URL;
(URL ? describe : describe.skip)("promote idempotency", () => {
  it("a second import does not duplicate", async () => {
    const c = new Client({ connectionString: URL }); await c.connect();
    try {
      // (seed shop + 2 sku_dim rows + inventory_level_fact as in the engine harness)
      const r1 = await c.query("select public.promote_shop_from_mirror($1) as r", ["00000000-0000-0000-0000-0000000000aa"]);
      const r2 = await c.query("select public.promote_shop_from_mirror($1) as r", ["00000000-0000-0000-0000-0000000000aa"]);
      expect(r2.rows[0].r.variants).toBe(r1.rows[0].r.variants);
      expect(r2.rows[0].r.products).toBe(r1.rows[0].r.products);
    } finally { await c.end(); }
  });
});
```

- [ ] **Step 2: Run it** (`TEST_DATABASE_URL=… npx vitest run tests/engine/import/promote-idempotency.test.ts`) — expect stable counts.

- [ ] **Step 3: Full gate** (paste results): `npm run typecheck` → `npm run lint` → `npm run build` → `npx vitest run`, all exit 0.

- [ ] **Step 4: Commit.**

```bash
git add tests/engine/import/promote-idempotency.test.ts
git commit -m "test(import): prove re-import is idempotent + green gate"
```

---

## Self-Review

**Spec coverage:**
- Warm-lead promote → Tasks 3-5 (`promote_shop_from_mirror` on already-mirrored data). ✅
- Fresh-merchant 12-month pull, background → Tasks 1 (param), 5 (drain via cron). ✅
- Idempotent re-run → Task 3 (`on conflict`) + Task 7 (proof). ✅
- Honest report (fixed exclusions) → Task 4 `buildImportReport` + Task 6 render. ✅
- Catalog-first, id-preserving (orders resolve) → Task 3 (products→variants with `id == sku_dim.id`, inventory last). ✅
- Out of scope (go-live flip, customers, theme) → not in any task. ✅

**Risk closures (from the spec):** initial pull reuses `backfillShop` (Task 1, no new fetcher); idempotency keyed on `external_id`/`id` + proven (Tasks 3, 7); scopes are the existing read scopes (no `read_customers`); 12-month window is the parameterized arg (Task 1).

**Placeholder scan:** the route/screen task (6) describes structure + the exact client calls; the JSX styling follows the sibling screens (codebase convention), consistent with the Slice 1 B2 plan — the novel logic (start/poll/report, the SQL fn, the drain) is in full.

**Type consistency:** `PromoteCounts` (Task 4) is returned by the SQL fn (Task 3) and consumed by the report + drain (Tasks 4-5). `backfillShop(domain, {sinceDays})` (Task 1) is called by the drain (Task 5) with 365. `import_run.state` values (`pulling|promoting|done|error`) match across Tasks 2, 5, 6.
