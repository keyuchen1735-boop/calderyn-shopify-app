# Slice 1 — Owned Catalog, Plan A (Data Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up Calderyn-owned catalog tables, populate them from the existing `sku_dim` mirror, and lock the `sku_dim`-stays-in-sync contract — so the editor (Plan B) has an owned source of truth and the engine keeps running unchanged.

**Architecture:** Add owned relational tables (`product_dim`, `variant_dim`, options, media, collections). Keep `sku_dim` as a **real table** (not a view) because `sku_dim.id` is a foreign-key target for orders/refunds/inventory and 7 views depend on it. The owned tables become the write authority; a re-projection function rebuilds a product's `sku_dim` rows from the owned tables **preserving `variant_dim.id` = `sku_dim.id`**, so every existing reference stays valid. The Shopify product-mirror write path is neutralized (catalog is now owned).

**Tech Stack:** Postgres (Supabase) migrations, `@supabase/supabase-js` service-role client, vitest. Local engine test DB via `tests/engine/scripts/test-db.sh` (disposable Postgres on `:5433`).

## Global Constraints

- TypeScript only; `tsc --noEmit` authoritative; no `any` without written justification.
- Schema changes go through a migration file in BOTH `supabase/migrations/` AND `tests/engine/schema/migrations/` (repo mirrors schema in both). Never hand-edit applied migrations.
- The `shops.id` UUID stays the tenant key. Do NOT alter `sku_dim`'s columns or any of the 7 dependent views (`v_skus_flat`, `v_sku_affinity`, `v_alerts_view`, `v_autopilot_candidates`, `v_peer_shop_niche`, `v_sku_regional_demand`, `v_sku_remediation_inputs`).
- **Hard invariant:** for every backfilled variant, `variant_dim.id` == the original `sku_dim.id`. Order/refund/inventory rows reference these ids; a new id would orphan them.
- New tables get `enable row level security` with no policies (service-role-only), consistent with the security-hardening posture.
- Migrations are additive and safe to run on prod (no staging): new tables + a backfill; `sku_dim` structurally untouched.
- Pre-commit gate before committing: `npm run typecheck` → `npm run lint` (`--max-warnings=0` on touched files) → `npm run build`, all exit 0; `npx vitest run` green.

### Exact `sku_dim` columns (the projection contract — read from prod 2026-06-28)

`id uuid`, `shop_id uuid`, `external_id text NOT NULL`, `product_id text NOT NULL`, `inventory_item_id text`, `sku text`, `title text NOT NULL`, `category text`, `price_tier text`, `unit_cost_cents int`, `currency text NOT NULL`, `tags text[] NOT NULL`, `created_at timestamptz`, `updated_at timestamptz`, `grams int`, `vendor text`, `collections text[] NOT NULL`, `inventory_policy text`, `inventory_tracked bool`, `retail_price_cents int`, `product_status text`.

---

### Task 1: Migration — owned catalog tables (DDL)

**Files:**
- Create: `supabase/migrations/20260628130000_owned_catalog_tables.sql`
- Create: `tests/engine/schema/migrations/20260628130000_owned_catalog_tables.sql` (identical copy)

**Interfaces:**
- Produces: `product_dim`, `variant_dim`, `product_option`, `product_option_value`, `variant_option_value`, `product_media`, `collection_dim`, `product_collection`. `variant_dim.id` defaults to `gen_random_uuid()` but is set explicitly during backfill (Task 2).

- [ ] **Step 1: Write the migration SQL** (same content to both paths)

```sql
-- Owned catalog (Slice 1, Plan A): product/variant source of truth, options,
-- media, collections. sku_dim stays a real table; these are the new authority.

create table if not exists public.product_dim (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  external_id text,                       -- legacy Shopify product GID (promoted rows); null for owned
  handle text not null,
  title text not null,
  status text not null default 'draft' check (status in ('draft','active','archived')),
  vendor text,
  category text,
  description text,
  tags text[] not null default '{}',
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (shop_id, handle)
);
create index if not exists product_dim_shop_updated_idx on public.product_dim(shop_id, updated_at desc);
create index if not exists product_dim_shop_status_idx on public.product_dim(shop_id, status);
create unique index if not exists product_dim_shop_external_key
  on public.product_dim(shop_id, external_id) where external_id is not null;
alter table public.product_dim enable row level security;

create table if not exists public.variant_dim (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  product_id uuid not null references public.product_dim(id) on delete cascade,
  external_id text,                       -- legacy Shopify variant GID; null for owned
  inventory_item_id text,
  sku text,
  title text not null default 'Default',
  price_tier text,
  retail_price_cents integer,
  unit_cost_cents integer,
  currency text not null default 'USD',
  grams integer,
  inventory_policy text,
  inventory_tracked boolean,
  inventory_on_hand integer not null default 0,
  requires_shipping boolean not null default true,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists variant_dim_shop_id_idx on public.variant_dim(shop_id);
create index if not exists variant_dim_product_id_idx on public.variant_dim(product_id);
create unique index if not exists variant_dim_shop_external_key
  on public.variant_dim(shop_id, external_id) where external_id is not null;
alter table public.variant_dim enable row level security;

create table if not exists public.product_option (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.product_dim(id) on delete cascade,
  name text not null,
  position integer not null default 0
);
create table if not exists public.product_option_value (
  id uuid primary key default gen_random_uuid(),
  option_id uuid not null references public.product_option(id) on delete cascade,
  value text not null,
  position integer not null default 0
);
create table if not exists public.variant_option_value (
  variant_id uuid not null references public.variant_dim(id) on delete cascade,
  option_value_id uuid not null references public.product_option_value(id) on delete cascade,
  primary key (variant_id, option_value_id)
);
alter table public.product_option enable row level security;
alter table public.product_option_value enable row level security;
alter table public.variant_option_value enable row level security;

create table if not exists public.product_media (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.product_dim(id) on delete cascade,
  storage_path text not null,
  alt text,
  position integer not null default 0,
  is_primary boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists product_media_product_id_idx on public.product_media(product_id);
create index if not exists product_media_primary_idx on public.product_media(product_id) where is_primary;
alter table public.product_media enable row level security;

create table if not exists public.collection_dim (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  handle text not null,
  title text not null,
  description text,
  created_at timestamptz not null default now(),
  unique (shop_id, handle)
);
create table if not exists public.product_collection (
  product_id uuid not null references public.product_dim(id) on delete cascade,
  collection_id uuid not null references public.collection_dim(id) on delete cascade,
  primary key (product_id, collection_id)
);
alter table public.collection_dim enable row level security;
alter table public.product_collection enable row level security;
```

- [ ] **Step 2: Apply to the local engine test DB and verify the tables exist**

Run:
```bash
bash tests/engine/scripts/test-db.sh up
PGPASSWORD=test psql -h localhost -p 5433 -U postgres -d calderyn_test -f tests/engine/schema/migrations/20260628130000_owned_catalog_tables.sql
PGPASSWORD=test psql -h localhost -p 5433 -U postgres -d calderyn_test -c "\dt public.product_dim public.variant_dim public.collection_dim"
```
Expected: all three tables listed; the `psql -f` runs with no errors (re-running it is idempotent — every statement is `if not exists`).

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260628130000_owned_catalog_tables.sql tests/engine/schema/migrations/20260628130000_owned_catalog_tables.sql
git commit -m "feat(catalog): owned product/variant/option/media/collection tables"
```

---

### Task 2: Migration — backfill owned tables from `sku_dim` (id-preserving)

**Files:**
- Create: `supabase/migrations/20260628130100_owned_catalog_backfill.sql`
- Create: `tests/engine/schema/migrations/20260628130100_owned_catalog_backfill.sql` (identical copy)

**Interfaces:**
- Consumes: the tables from Task 1; the existing `sku_dim` rows.
- Produces: one `product_dim` per distinct `(shop_id, product_id)`; one `variant_dim` per `sku_dim` row with **`variant_dim.id` = `sku_dim.id`**; `collection_dim` + `product_collection` from the `sku_dim.collections` text arrays.

- [ ] **Step 1: Write the backfill SQL** (same content to both paths)

```sql
-- Backfill owned tables from the existing sku_dim mirror. Idempotent via
-- on-conflict guards. variant_dim.id is set to sku_dim.id so every order/refund/
-- inventory reference to the variant survives unchanged.
-- CONSOLIDATION: wrap the catalog+collections inserts below in a function
-- `promote_shop_catalog(p_shop_id uuid)` (scoped to one shop) and have this
-- migration call it for every shop (e.g. `select promote_shop_catalog(id) from shops`).
-- The Shopify-import feature reuses the SAME function (see its plan) so the
-- catalog-promote logic lives in exactly one place.

-- 1) Products: one per distinct (shop_id, product_id GID). Product-level columns
--    are denormalized identically across a product's sku_dim rows, so DISTINCT ON
--    any row is correct. handle is a deterministic slug (unique per shop).
insert into public.product_dim (shop_id, external_id, handle, title, status, vendor, category, tags, created_at, updated_at)
select distinct on (s.shop_id, s.product_id)
  s.shop_id,
  s.product_id,
  'p-' || substr(md5(s.shop_id::text || ':' || s.product_id), 1, 16),
  s.title,
  case when s.product_status in ('draft','active','archived') then s.product_status else 'active' end,
  s.vendor,
  s.category,
  s.tags,
  s.created_at,
  s.updated_at
from public.sku_dim s
order by s.shop_id, s.product_id, s.created_at
on conflict (shop_id, external_id) where (external_id is not null) do nothing;

-- 2) Variants: one per sku_dim row, id PRESERVED.
insert into public.variant_dim (id, shop_id, product_id, external_id, inventory_item_id, sku, title, price_tier, retail_price_cents, unit_cost_cents, currency, grams, inventory_policy, inventory_tracked, inventory_on_hand, created_at, updated_at)
select
  s.id,
  s.shop_id,
  p.id,
  s.external_id,
  s.inventory_item_id,
  s.sku,
  s.title,
  s.price_tier,
  s.retail_price_cents,
  s.unit_cost_cents,
  s.currency,
  s.grams,
  s.inventory_policy,
  s.inventory_tracked,
  0,
  s.created_at,
  s.updated_at
from public.sku_dim s
join public.product_dim p on p.shop_id = s.shop_id and p.external_id = s.product_id
on conflict (id) do nothing;

-- 3) Collections from the text[] arrays (one collection_dim per distinct name per shop).
insert into public.collection_dim (shop_id, handle, title)
select distinct
  s.shop_id,
  substr(regexp_replace(lower(c.name), '[^a-z0-9]+', '-', 'g'), 1, 60),
  c.name
from public.sku_dim s
cross join lateral unnest(s.collections) as c(name)
where c.name is not null and length(trim(c.name)) > 0
on conflict (shop_id, handle) do nothing;

-- 4) Link products to their collections.
insert into public.product_collection (product_id, collection_id)
select distinct p.id, col.id
from public.sku_dim s
join public.product_dim p on p.shop_id = s.shop_id and p.external_id = s.product_id
cross join lateral unnest(s.collections) as c(name)
join public.collection_dim col on col.shop_id = s.shop_id and col.title = c.name
where c.name is not null and length(trim(c.name)) > 0
on conflict (product_id, collection_id) do nothing;
```

- [ ] **Step 2: Write a verification SQL script that fails before backfill, passes after**

Create `tests/engine/schema/checks/owned_catalog_backfill_check.sql`:

```sql
-- Every sku_dim row must have a matching variant_dim row with the SAME id.
-- Returns the count of mismatches; must be 0.
select
  (select count(*) from public.sku_dim) as sku_rows,
  (select count(*) from public.variant_dim) as variant_rows,
  (select count(*) from public.sku_dim s
     left join public.variant_dim v on v.id = s.id
     where v.id is null) as orphan_sku_rows,
  (select count(distinct product_id) from public.sku_dim) as distinct_products,
  (select count(*) from public.product_dim) as product_rows;
```

- [ ] **Step 3: Seed sample data, run the backfill, and verify parity**

Run:
```bash
PGPASSWORD=test psql -h localhost -p 5433 -U postgres -d calderyn_test -c "
  insert into public.shops (id, shop_domain) values ('00000000-0000-0000-0000-0000000000aa','demo.myshopify.com') on conflict do nothing;
  insert into public.sku_dim (id, shop_id, external_id, product_id, title, currency, tags, collections, retail_price_cents, product_status, vendor)
  values
   ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000aa','gid://v/1','gid://p/1','Tee S', 'USD', '{summer}', '{Summer}', 1999, 'active', 'Acme'),
   ('00000000-0000-0000-0000-0000000000b2','00000000-0000-0000-0000-0000000000aa','gid://v/2','gid://p/1','Tee M', 'USD', '{summer}', '{Summer}', 1999, 'active', 'Acme')
  on conflict do nothing;"
PGPASSWORD=test psql -h localhost -p 5433 -U postgres -d calderyn_test -f tests/engine/schema/migrations/20260628130100_owned_catalog_backfill.sql
PGPASSWORD=test psql -h localhost -p 5433 -U postgres -d calderyn_test -f tests/engine/schema/checks/owned_catalog_backfill_check.sql
```
Expected: `orphan_sku_rows = 0`, `variant_rows = sku_rows`, `product_rows = distinct_products` (here: 2 variants, 1 product, 0 orphans).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260628130100_owned_catalog_backfill.sql tests/engine/schema/migrations/20260628130100_owned_catalog_backfill.sql tests/engine/schema/checks/owned_catalog_backfill_check.sql
git commit -m "feat(catalog): id-preserving backfill from sku_dim into owned tables"
```

---

### Task 3: `sku_dim` re-projection function + neutralize the Shopify product mirror

**Files:**
- Create: `app/lib/catalog/project-sku-dim.server.ts`
- Modify: `app/lib/ingest/transform.server.ts:80-87` (neutralize `applyProduct`)
- Test: `app/lib/catalog/__tests__/project-sku-dim.server.test.ts`

**Interfaces:**
- Consumes: `getSupabase` (`app/lib/supabase.server.ts`).
- Produces:
  - `projectProductToSkuDim(productId: string): Promise<void>` — rebuilds the `sku_dim` rows for one product from the owned tables, **using `variant_dim.id` as `sku_dim.id`** (upsert on `id`), and deletes `sku_dim` rows for variants that no longer exist. This is the single sync contract the editor (Plan B) calls after every write.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

const variantRows = [
  { id: "v1", external_id: null, inventory_item_id: null, sku: "TEE-S", title: "Tee S", price_tier: null, retail_price_cents: 1999, unit_cost_cents: 800, currency: "USD", grams: 200, inventory_policy: "deny", inventory_tracked: true },
];
const productRow = { id: "p1", external_id: null, status: "active", vendor: "Acme", category: "Shirts", tags: ["summer"] };

const upsert = vi.fn().mockResolvedValue({ error: null });
const del = vi.fn(() => ({ eq: () => ({ not: () => Promise.resolve({ error: null }) }) }));
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    from: (table: string) => {
      if (table === "product_dim") return { select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: productRow, error: null }) }) }) };
      if (table === "variant_dim") return { select: () => ({ eq: () => Promise.resolve({ data: variantRows, error: null }) }) };
      if (table === "product_collection") return { select: () => ({ eq: () => Promise.resolve({ data: [{ collection: { title: "Summer" } }], error: null }) }) };
      // sku_dim
      return { upsert, delete: del };
    },
  }),
}));

beforeEach(() => { upsert.mockClear(); });

describe("projectProductToSkuDim", () => {
  it("upserts a sku_dim row per variant, preserving the variant id and denormalizing product fields", async () => {
    const { projectProductToSkuDim } = await import("../project-sku-dim.server");
    await projectProductToSkuDim("p1");
    expect(upsert).toHaveBeenCalledTimes(1);
    const [rows, opts] = upsert.mock.calls[0];
    expect(opts).toEqual({ onConflict: "id" });
    expect(rows[0]).toEqual(expect.objectContaining({
      id: "v1",                       // sku_dim.id == variant_dim.id (invariant)
      product_id: null,               // owned product → coalesces to product uuid; see impl note
      external_id: "v1",              // owned variant → coalesces to variant uuid
      retail_price_cents: 1999,
      product_status: "active",
      vendor: "Acme",
      collections: ["Summer"],
      tags: ["summer"],
    }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/catalog/__tests__/project-sku-dim.server.test.ts`
Expected: FAIL — cannot find module `../project-sku-dim.server`.

- [ ] **Step 3: Write the projection function**

```typescript
// app/lib/catalog/project-sku-dim.server.ts
//
// sku_dim stays the engine's read model (a real table — it is a FK target and 7
// views depend on it). The owned product/variant tables are the write authority;
// after any catalog write the editor calls this to rebuild that product's sku_dim
// rows. The variant id is carried verbatim into sku_dim.id so order/refund/
// inventory references never break.
import { getSupabase } from "../supabase.server";

export async function projectProductToSkuDim(productId: string): Promise<void> {
  const sb = getSupabase();

  const { data: product, error: pErr } = await sb
    .from("product_dim")
    .select("id, shop_id, external_id, status, vendor, category, tags")
    .eq("id", productId)
    .single();
  if (pErr) throw pErr;

  const { data: variants, error: vErr } = await sb
    .from("variant_dim")
    .select("id, external_id, inventory_item_id, sku, title, price_tier, retail_price_cents, unit_cost_cents, currency, grams, inventory_policy, inventory_tracked")
    .eq("product_id", productId);
  if (vErr) throw vErr;

  const { data: cols, error: cErr } = await sb
    .from("product_collection")
    .select("collection:collection_dim(title)")
    .eq("product_id", productId);
  if (cErr) throw cErr;
  const collections = (cols ?? [])
    .map((r: { collection: { title: string } | null }) => r.collection?.title)
    .filter((t): t is string => Boolean(t));

  const productExternal = product.external_id ?? String(product.id);
  const rows = (variants ?? []).map((v: Record<string, unknown>) => ({
    id: String(v.id),                                   // INVARIANT: sku_dim.id == variant_dim.id
    shop_id: String(product.shop_id),
    external_id: (v.external_id as string | null) ?? String(v.id),
    product_id: productExternal,
    inventory_item_id: v.inventory_item_id ?? null,
    sku: v.sku ?? null,
    title: v.title ?? "Default",
    category: product.category ?? null,
    price_tier: v.price_tier ?? null,
    unit_cost_cents: v.unit_cost_cents ?? null,
    currency: v.currency ?? "USD",
    tags: product.tags ?? [],
    grams: v.grams ?? null,
    vendor: product.vendor ?? null,
    collections,
    inventory_policy: v.inventory_policy ?? null,
    inventory_tracked: v.inventory_tracked ?? null,
    retail_price_cents: v.retail_price_cents ?? null,
    product_status: product.status ?? null,
  }));

  if (rows.length) {
    const { error: upErr } = await sb.from("sku_dim").upsert(rows, { onConflict: "id" });
    if (upErr) throw upErr;
  }

  // Remove sku_dim rows for variants that no longer exist on this product.
  const keepIds = rows.map((r) => r.id);
  const del = sb.from("sku_dim").delete().eq("product_id", productExternal);
  const { error: delErr } = keepIds.length
    ? await del.not("id", "in", `(${keepIds.map((i) => `'${i}'`).join(",")})`)
    : await del;
  if (delErr) throw delErr;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/catalog/__tests__/project-sku-dim.server.test.ts`
Expected: PASS.

- [ ] **Step 5: Neutralize the Shopify product mirror** (catalog is owned now)

Replace the body of `applyProduct` in `app/lib/ingest/transform.server.ts` (currently `transform.server.ts:80-87`) so it no longer upserts `sku_dim`:

```typescript
async function applyProduct(_shopId: string, _payload: Record<string, unknown>): Promise<number> {
  // Catalog is Calderyn-owned (Slice 1). The Shopify product mirror is retired;
  // products are authored in the dashboard and projected into sku_dim by
  // projectProductToSkuDim. Inbound product webhooks are acknowledged (stamped
  // processed) but no longer overwrite owned catalog data.
  return 0;
}
```

- [ ] **Step 6: Run the focused tests + typecheck**

Run: `npx vitest run app/lib/catalog app/lib/ingest && npm run typecheck`
Expected: PASS; typecheck exit 0. (If `parseProductWebhook` becomes an unused import in `transform.server.ts`, remove it.)

- [ ] **Step 7: Commit**

```bash
git add app/lib/catalog/project-sku-dim.server.ts app/lib/catalog/__tests__/project-sku-dim.server.test.ts app/lib/ingest/transform.server.ts
git commit -m "feat(catalog): sku_dim re-projection sync + retire Shopify product mirror"
```

---

### Task 4: Full verification — engine intact end to end

**Files:**
- No new source. This task's deliverable is a green gate proving the engine still resolves against `sku_dim` after the migration + backfill, with ids preserved.

- [ ] **Step 1: Re-run the backfill parity check on a fresh local DB**

Run:
```bash
bash tests/engine/scripts/test-db.sh reset
bash tests/engine/scripts/test-db.sh up
# the harness applies all tests/engine/schema/migrations in order, including the two new ones
PGPASSWORD=test psql -h localhost -p 5433 -U postgres -d calderyn_test -c "select 1 from public.v_skus_flat limit 1;"
```
Expected: the migration chain applies cleanly; `v_skus_flat` resolves (returns 0 or more rows, no error) — proving the dependent views still bind to `sku_dim`.

- [ ] **Step 2: Confirm the 7 dependent views still resolve**

Run:
```bash
for v in v_skus_flat v_sku_affinity v_alerts_view v_autopilot_candidates v_peer_shop_niche v_sku_regional_demand v_sku_remediation_inputs; do
  PGPASSWORD=test psql -h localhost -p 5433 -U postgres -d calderyn_test -c "select 1 from public.$v limit 1;" || echo "FAILED: $v";
done
```
Expected: no `FAILED:` lines.

- [ ] **Step 3: Run the full app gate**

Run, in order, pasting results (rule 12 — evidence, not assertion):
```bash
npm run typecheck   # exit 0
npm run lint        # exit 0
npm run build       # exit 0
npx vitest run      # all green
```
Expected: every command exits 0.

- [ ] **Step 4: Commit (if any lint/type fixes were needed)**

```bash
git add -A
git commit -m "test(catalog): verify engine + dependent views intact after owned-catalog foundation"
```

---

## Self-Review

**Spec coverage (against `docs/superpowers/specs/2026-06-28-slice-1-owned-catalog-design.md`):**
- Owned tables (`product_dim`, `variant_dim`, options, media, collections) → Task 1. ✅
- `inventory_on_hand` per variant (the stock-count addition) → Task 1 `variant_dim`. ✅
- Promote existing demo data → Task 2 (id-preserving). ✅
- Keep the engine alive → **design change, flagged:** `sku_dim` stays a real table (FK target + 7 dependent views), kept in sync by `projectProductToSkuDim` (Task 3) instead of being replaced by a view. Same success criterion ("engine runs unchanged"), lower risk. Verified in Task 4. ✅
- Retire the Shopify product mirror (owned authority) → Task 3 Step 5. ✅
- Purely owned / no sync → no Shopify write-back anywhere in this plan. ✅

**Out of scope (Plan B — the editor):** the `dashboard.api.*` CRUD endpoints, the product-list / product-editor / collections UI, image upload to the `product-media` Supabase Storage bucket, and wiring `projectProductToSkuDim` into each editor write.

**Design-change callout (needs user awareness):** the spec said "replace `sku_dim` with a view." The grep proved `sku_dim.id` is a FK target (orders/refunds/inventory) and 7 views depend on it — Postgres FKs cannot reference a view, so a view would break referential integrity. This plan keeps `sku_dim` a table and re-projects into it, preserving `variant_dim.id == sku_dim.id`. Same outcome, safer.

**Placeholder scan:** none — every step has concrete SQL/code/commands.

**Type/invariant consistency:** `variant_dim.id == sku_dim.id` is enforced in Task 2 (backfill `select s.id`) and Task 3 (`id: String(v.id)` + `onConflict: "id"`). `projectProductToSkuDim(productId): Promise<void>` is the one sync entry point Plan B consumes.
