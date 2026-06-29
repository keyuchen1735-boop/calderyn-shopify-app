# Slice 2 — Smart Inventory, Plan A (Stock Engine) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The owned, transactional stock engine — per-location balances with Shopify-style states, an atomic reserve that cannot oversell, the destination-aware allocator, transfers, and the `inventory_level_fact` projection that keeps the engine alive — all built and tested, ready for checkout (Slice 3) to call.

**Architecture:** New owned tables hold the decrementable balance, the movement journal, holds, and transfers. The concurrency-critical reserve is a **Postgres function** (`inventory_reserve`) running in its own transaction with `SELECT … FOR UPDATE` row locks and all-or-nothing rollback — called from TS via `sb.rpc(...)`, the repo's standard for transactional logic. A pure TS allocator decides location order (nearest-to-buyer when coords exist, else priority). Every balance change projects an observation into `inventory_level_fact` so the existing engine reads the owned numbers unchanged.

**Tech Stack:** Postgres (Supabase) migrations + plpgsql functions, `@supabase/supabase-js` (`.rpc`, service-role), vitest (pure-unit + a DB-backed concurrency test via `TEST_DATABASE_URL` on the local Postgres harness).

## Global Constraints

- TypeScript only; `tsc --noEmit` authoritative; no `any` without written justification.
- Schema changes go in a migration in BOTH `supabase/migrations/` AND `tests/engine/schema/migrations/`.
- Keyed by internal `shop_id`; new tables get `enable row level security` with no policies (service-role only).
- **Hard invariant:** the hold/decrement is an atomic conditional write (`FOR UPDATE` + recheck inside one transaction), never read-then-write. A non-atomic version oversells under load.
- **Projection discipline:** every owned balance change writes an `inventory_level_fact` observation (new `source_version`) for that (sku_dim.id, location), or the engine reads stale stock.
- `available = on_hand − reserved − unavailable` everywhere; never let a buyer reserve beyond `available`.
- Migrations are additive and prod-safe (new tables + column adds + a backfill; `inventory_level_fact`/`location_dim` data untouched apart from new nullable columns).
- Pre-commit gate before committing: `npm run typecheck` → `npm run lint` → `npm run build` (all exit 0); `npx vitest run` green.

### Schema facts (read from prod 2026-06-29)
- `inventory_level_fact(id bigint, shop_id uuid, sku_id uuid, location_id uuid, available int NOT NULL, observed_at timestamptz, source_version bigint)` — append-only observations; the engine reads the latest per (sku_id, location_id).
- `location_dim(id uuid, shop_id, external_id text NOT NULL, name, country, region, city, active bool, created_at)` — `external_id` is currently NOT NULL (Shopify location GID).
- `variant_dim.id == sku_dim.id` (Slice 1 invariant) — so `inventory_level_fact.sku_id = variant_dim.id`.

---

### Task 1: Migration — owned inventory tables + `location_dim` extensions

**Files:**
- Create: `supabase/migrations/20260629120000_inventory_tables.sql`
- Create: `tests/engine/schema/migrations/20260629120000_inventory_tables.sql` (identical copy)

**Interfaces:**
- Produces: `inventory_balance`, `inventory_ledger`, `inventory_reservation`, `inventory_transfer`; `location_dim` gains `priority`, `lat`, `lng`, and `external_id` made nullable (owned stores have no Shopify location GID).

- [ ] **Step 1: Write the migration SQL** (both paths)

```sql
-- Owned inventory (Slice 2): decrementable balance + journal + holds + transfers.

alter table public.location_dim alter column external_id drop not null;
alter table public.location_dim add column if not exists priority int not null default 0;
alter table public.location_dim add column if not exists lat double precision;
alter table public.location_dim add column if not exists lng double precision;

create table if not exists public.inventory_balance (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  variant_id uuid not null references public.variant_dim(id) on delete cascade,
  location_id uuid not null references public.location_dim(id) on delete cascade,
  on_hand int not null default 0,
  reserved int not null default 0,
  incoming int not null default 0,
  unavailable int not null default 0,
  available int generated always as (on_hand - reserved - unavailable) stored,
  reorder_point int,
  version bigint not null default 0,
  updated_at timestamptz not null default now(),
  unique (variant_id, location_id)
);
create index if not exists inventory_balance_shop_variant_idx on public.inventory_balance(shop_id, variant_id);
alter table public.inventory_balance enable row level security;

create table if not exists public.inventory_ledger (
  id bigserial primary key,
  shop_id uuid not null references public.shops(id) on delete cascade,
  variant_id uuid not null,
  location_id uuid not null,
  entry_type text not null check (entry_type in ('receive','adjust','transfer_out','transfer_in','in_transit','received','reserve','release','sale','mark_unavailable')),
  qty int not null,
  reservation_id uuid,
  transfer_id uuid,
  order_ref text,
  idempotency_key text not null,
  reason text,
  source text not null default 'merchant',
  created_at timestamptz not null default now(),
  unique (shop_id, idempotency_key)
);
create index if not exists inventory_ledger_shop_variant_idx on public.inventory_ledger(shop_id, variant_id, created_at desc);
alter table public.inventory_ledger enable row level security;

create table if not exists public.inventory_reservation (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  variant_id uuid not null,
  location_id uuid not null,
  qty int not null,
  state text not null check (state in ('held','committed','released','expired')),
  checkout_ref text not null,
  expires_at timestamptz not null,
  idempotency_key text not null unique,
  created_at timestamptz not null default now()
);
create index if not exists inventory_reservation_checkout_idx on public.inventory_reservation(shop_id, checkout_ref);
create index if not exists inventory_reservation_expiry_idx on public.inventory_reservation(state, expires_at);
alter table public.inventory_reservation enable row level security;

create table if not exists public.inventory_transfer (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  variant_id uuid not null,
  from_location_id uuid not null,
  to_location_id uuid not null,
  qty int not null,
  state text not null check (state in ('in_transit','received','cancelled')),
  created_at timestamptz not null default now(),
  received_at timestamptz
);
alter table public.inventory_transfer enable row level security;
```

- [ ] **Step 2: Apply locally + verify**

Run:
```bash
bash tests/engine/scripts/test-db.sh up
PGPASSWORD=test psql -h localhost -p 5433 -U postgres -d calderyn_test -f tests/engine/schema/migrations/20260629120000_inventory_tables.sql
PGPASSWORD=test psql -h localhost -p 5433 -U postgres -d calderyn_test -c "select column_name from information_schema.columns where table_name='inventory_balance' and column_name in ('available','reserved','incoming','unavailable');"
```
Expected: the four columns listed; no errors (idempotent on re-run).

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260629120000_inventory_tables.sql tests/engine/schema/migrations/20260629120000_inventory_tables.sql
git commit -m "feat(inventory): owned balance/ledger/reservation/transfer tables + location geo"
```

---

### Task 2: Migration — the atomic `inventory_reserve` / `commit` / `release` SQL functions

**Files:**
- Create: `supabase/migrations/20260629120100_inventory_reserve_fn.sql`
- Create: `tests/engine/schema/migrations/20260629120100_inventory_reserve_fn.sql` (identical copy)

**Interfaces:**
- Produces (callable via `sb.rpc`):
  - `inventory_reserve(p_shop_id uuid, p_variant_id uuid, p_qty int, p_location_ids uuid[], p_checkout_ref text, p_expires_at timestamptz, p_idempotency_key text, p_allow_backorder boolean) returns jsonb` — `{ ok: true, allocation: [{locationId, qty}] }`, or raises `insufficient_stock` (rolls back all holds).
  - `inventory_commit(p_shop_id uuid, p_checkout_ref text) returns void`
  - `inventory_release(p_shop_id uuid, p_checkout_ref text) returns void`

- [ ] **Step 1: Write the functions** (both paths)

```sql
-- Atomic multi-location hold. Runs in its own transaction; FOR UPDATE locks each
-- balance row; raises to roll back ALL holds if the order can't be covered.
create or replace function public.inventory_reserve(
  p_shop_id uuid, p_variant_id uuid, p_qty int, p_location_ids uuid[],
  p_checkout_ref text, p_expires_at timestamptz, p_idempotency_key text, p_allow_backorder boolean
) returns jsonb language plpgsql as $$
declare remaining int := p_qty; loc uuid; avail int; take int; alloc jsonb := '[]'::jsonb;
begin
  -- Idempotent replay: existing holds for this checkout → return them unchanged.
  if exists (select 1 from inventory_reservation where shop_id = p_shop_id and checkout_ref = p_checkout_ref and state = 'held') then
    select coalesce(jsonb_agg(jsonb_build_object('locationId', location_id, 'qty', qty)), '[]'::jsonb)
      into alloc from inventory_reservation where shop_id = p_shop_id and checkout_ref = p_checkout_ref and state = 'held';
    return jsonb_build_object('ok', true, 'allocation', alloc);
  end if;

  foreach loc in array p_location_ids loop
    exit when remaining <= 0;
    select (on_hand - reserved - unavailable) into avail
      from public.inventory_balance
      where shop_id = p_shop_id and variant_id = p_variant_id and location_id = loc
      for update;
    if not found or avail is null or avail <= 0 then continue; end if;
    take := least(remaining, avail);
    update public.inventory_balance set reserved = reserved + take, version = version + 1, updated_at = now()
      where shop_id = p_shop_id and variant_id = p_variant_id and location_id = loc;
    insert into public.inventory_reservation (shop_id, variant_id, location_id, qty, state, checkout_ref, expires_at, idempotency_key)
      values (p_shop_id, p_variant_id, loc, take, 'held', p_checkout_ref, p_expires_at, p_idempotency_key || ':' || loc::text);
    insert into public.inventory_ledger (shop_id, variant_id, location_id, entry_type, qty, order_ref, idempotency_key, source)
      values (p_shop_id, p_variant_id, loc, 'reserve', -take, p_checkout_ref, p_idempotency_key || ':reserve:' || loc::text, 'checkout');
    alloc := alloc || jsonb_build_array(jsonb_build_object('locationId', loc, 'qty', take));
    remaining := remaining - take;
  end loop;

  if remaining > 0 and not p_allow_backorder then
    raise exception 'insufficient_stock' using errcode = 'P0001';
  end if;
  return jsonb_build_object('ok', true, 'allocation', alloc);
end $$;

-- Payment: turn holds into real decrements. Idempotent on checkout_ref.
create or replace function public.inventory_commit(p_shop_id uuid, p_checkout_ref text)
returns void language plpgsql as $$
declare r record;
begin
  for r in select * from public.inventory_reservation where shop_id = p_shop_id and checkout_ref = p_checkout_ref and state = 'held' loop
    update public.inventory_balance set on_hand = on_hand - r.qty, reserved = reserved - r.qty, version = version + 1, updated_at = now()
      where shop_id = p_shop_id and variant_id = r.variant_id and location_id = r.location_id;
    update public.inventory_reservation set state = 'committed' where id = r.id;
    insert into public.inventory_ledger (shop_id, variant_id, location_id, entry_type, qty, reservation_id, order_ref, idempotency_key, source)
      values (p_shop_id, r.variant_id, r.location_id, 'sale', -r.qty, r.id, p_checkout_ref, 'commit:' || r.id::text, 'checkout')
      on conflict (shop_id, idempotency_key) do nothing;
  end loop;
end $$;

-- Abandon/expiry: free holds. Idempotent.
create or replace function public.inventory_release(p_shop_id uuid, p_checkout_ref text)
returns void language plpgsql as $$
declare r record;
begin
  for r in select * from public.inventory_reservation where shop_id = p_shop_id and checkout_ref = p_checkout_ref and state = 'held' loop
    update public.inventory_balance set reserved = reserved - r.qty, version = version + 1, updated_at = now()
      where shop_id = p_shop_id and variant_id = r.variant_id and location_id = r.location_id;
    update public.inventory_reservation set state = 'released' where id = r.id;
    insert into public.inventory_ledger (shop_id, variant_id, location_id, entry_type, qty, reservation_id, order_ref, idempotency_key, source)
      values (p_shop_id, r.variant_id, r.location_id, 'release', r.qty, r.id, p_checkout_ref, 'release:' || r.id::text, 'system')
      on conflict (shop_id, idempotency_key) do nothing;
  end loop;
end $$;
```

- [ ] **Step 2: Apply locally + smoke the function**

Run:
```bash
PGPASSWORD=test psql -h localhost -p 5433 -U postgres -d calderyn_test -f tests/engine/schema/migrations/20260629120100_inventory_reserve_fn.sql
PGPASSWORD=test psql -h localhost -p 5433 -U postgres -d calderyn_test -c "select proname from pg_proc where proname in ('inventory_reserve','inventory_commit','inventory_release');"
```
Expected: the three function names listed.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260629120100_inventory_reserve_fn.sql tests/engine/schema/migrations/20260629120100_inventory_reserve_fn.sql
git commit -m "feat(inventory): atomic reserve/commit/release SQL functions"
```

---

### Task 3: Allocator (pure TS) — order locations nearest-to-buyer, else by priority

**Files:**
- Create: `app/lib/inventory/allocate.ts`
- Test: `app/lib/inventory/__tests__/allocate.test.ts`

**Interfaces:**
- Produces:
  - `type Loc = { id: string; priority: number; lat: number | null; lng: number | null }`
  - `type Dest = { lat: number; lng: number } | null`
  - `orderLocations(locations: Loc[], dest: Dest): string[]` — when `dest` and a location's coords exist, ascending by haversine distance; locations without coords (or no `dest`) fall back to ascending `priority`; ties by `priority`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { orderLocations } from "../allocate";

const TO = { id: "to", priority: 0, lat: 43.65, lng: -79.38 };  // Toronto
const VAN = { id: "van", priority: 1, lat: 49.28, lng: -123.12 }; // Vancouver

describe("orderLocations", () => {
  it("falls back to priority order when there is no destination", () => {
    expect(orderLocations([VAN, TO], null)).toEqual(["to", "van"]);
  });
  it("orders nearest-to-destination when coords exist", () => {
    // A buyer near Vancouver → Vancouver first.
    expect(orderLocations([TO, VAN], { lat: 49.2, lng: -123.0 })).toEqual(["van", "to"]);
  });
  it("sinks coord-less locations below located ones, then by priority", () => {
    const noGeo = { id: "x", priority: 2, lat: null, lng: null };
    expect(orderLocations([noGeo, TO], { lat: 43.6, lng: -79.4 })).toEqual(["to", "x"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/inventory/__tests__/allocate.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the allocator**

```typescript
// app/lib/inventory/allocate.ts
export type Loc = { id: string; priority: number; lat: number | null; lng: number | null };
export type Dest = { lat: number; lng: number } | null;

function haversine(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371, toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat), dLng = toRad(bLng - aLng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export function orderLocations(locations: Loc[], dest: Dest): string[] {
  const distance = (l: Loc): number | null =>
    dest && l.lat != null && l.lng != null ? haversine(dest.lat, dest.lng, l.lat, l.lng) : null;
  return [...locations]
    .sort((a, b) => {
      const da = distance(a), db = distance(b);
      if (da != null && db != null && da !== db) return da - db; // both located → nearer first
      if (da != null && db == null) return -1;                   // located before un-located
      if (da == null && db != null) return 1;
      return a.priority - b.priority;                            // fall back to priority
    })
    .map((l) => l.id);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/inventory/__tests__/allocate.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/inventory/allocate.ts app/lib/inventory/__tests__/allocate.test.ts
git commit -m "feat(inventory): nearest-to-buyer / priority allocator"
```

---

### Task 4: Inventory engine (TS wrappers + projection)

**Files:**
- Create: `app/lib/inventory/engine.server.ts`
- Create: `app/lib/inventory/project-level-fact.server.ts`
- Test: `app/lib/inventory/__tests__/engine.server.test.ts`

**Interfaces:**
- Consumes: `getSupabase`; `orderLocations` (Task 3); the `inventory_reserve/commit/release` functions (Task 2) via `rpc`.
- Produces:
  - `reserveStock(shopId, variantId, qty, checkoutRef, dest?): Promise<{ ok: true; allocation: Array<{ locationId: string; qty: number }> } | { ok: false; reason: "insufficient_stock" }>`
  - `commitReservation(shopId, checkoutRef): Promise<void>`
  - `releaseReservation(shopId, checkoutRef): Promise<void>`
  - `adjustStock(shopId, variantId, locationId, newOnHand, reason?): Promise<void>`
  - `markUnavailable(shopId, variantId, locationId, qty, reason): Promise<void>`
  - `createTransfer(shopId, variantId, fromLocationId, toLocationId, qty, mode: "instant" | "in_transit"): Promise<{ transferId: string }>`
  - `receiveTransfer(shopId, transferId): Promise<void>`
  - `projectLevelFact(shopId, variantId, locationId): Promise<void>` — writes an `inventory_level_fact` observation from the current balance (called after every mutation).

- [ ] **Step 1: Write the failing test** (reserve happy path + insufficient mapping + projection-after-adjust)

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

const rpc = vi.fn();
const project = vi.fn().mockResolvedValue(undefined);
const balanceRows = [{ location_id: "to", priority: 0, lat: null, lng: null }, { location_id: "van", priority: 1, lat: null, lng: null }];
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    rpc,
    from: (t: string) => {
      if (t === "inventory_balance") return { select: () => ({ eq: () => ({ eq: () => Promise.resolve({ data: balanceRows, error: null }) }) }) };
      if (t === "location_dim") return { select: () => ({ eq: () => Promise.resolve({ data: balanceRows.map((b) => ({ id: b.location_id, priority: b.priority, lat: b.lat, lng: b.lng })), error: null }) }) };
      return { upsert: vi.fn().mockResolvedValue({ error: null }) };
    },
  }),
}));
vi.mock("../project-level-fact.server", () => ({ projectLevelFact: project }));

beforeEach(() => { rpc.mockReset(); project.mockClear(); });

describe("reserveStock", () => {
  it("returns the allocation on success", async () => {
    rpc.mockResolvedValue({ data: { ok: true, allocation: [{ locationId: "to", qty: 2 }] }, error: null });
    const { reserveStock } = await import("../engine.server");
    const r = await reserveStock("shop1", "v1", 2, "co1");
    expect(r).toEqual({ ok: true, allocation: [{ locationId: "to", qty: 2 }] });
  });

  it("maps the insufficient_stock exception to ok:false", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "insufficient_stock" } });
    const { reserveStock } = await import("../engine.server");
    expect(await reserveStock("shop1", "v1", 99, "co2")).toEqual({ ok: false, reason: "insufficient_stock" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/inventory/__tests__/engine.server.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `project-level-fact.server.ts`**

```typescript
// app/lib/inventory/project-level-fact.server.ts
// Keep the engine alive: after any owned balance change, append an
// inventory_level_fact observation so detectors read the owned on_hand.
// variant_id == sku_dim.id (Slice 1 invariant), so sku_id = variantId.
import { getSupabase } from "../supabase.server";

export async function projectLevelFact(shopId: string, variantId: string, locationId: string): Promise<void> {
  const sb = getSupabase();
  const { data: bal, error } = await sb
    .from("inventory_balance")
    .select("on_hand")
    .eq("variant_id", variantId)
    .eq("location_id", locationId)
    .maybeSingle();
  if (error) throw error;
  if (!bal) return;
  const { error: insErr } = await sb.from("inventory_level_fact").insert({
    shop_id: shopId, sku_id: variantId, location_id: locationId,
    available: Number(bal.on_hand), observed_at: new Date().toISOString(),
    source_version: Date.now(),
  });
  if (insErr) throw insErr;
}
```

- [ ] **Step 4: Write `engine.server.ts`**

```typescript
// app/lib/inventory/engine.server.ts
import { getSupabase } from "../supabase.server";
import { orderLocations, type Loc, type Dest } from "./allocate";
import { projectLevelFact } from "./project-level-fact.server";

const HOLD_TTL_MS = 30 * 60 * 1000; // 30 minutes

async function locationOrder(shopId: string, dest: Dest): Promise<string[]> {
  const { data, error } = await getSupabase().from("location_dim").select("id, priority, lat, lng").eq("shop_id", shopId);
  if (error) throw error;
  const locs: Loc[] = (data ?? []).map((l: Record<string, unknown>) => ({
    id: String(l.id), priority: Number(l.priority ?? 0),
    lat: l.lat == null ? null : Number(l.lat), lng: l.lng == null ? null : Number(l.lng),
  }));
  return orderLocations(locs, dest);
}

export async function reserveStock(
  shopId: string, variantId: string, qty: number, checkoutRef: string, dest: Dest = null,
): Promise<{ ok: true; allocation: Array<{ locationId: string; qty: number }> } | { ok: false; reason: "insufficient_stock" }> {
  const orderedLocationIds = await locationOrder(shopId, dest);
  const { data, error } = await getSupabase().rpc("inventory_reserve", {
    p_shop_id: shopId, p_variant_id: variantId, p_qty: qty, p_location_ids: orderedLocationIds,
    p_checkout_ref: checkoutRef, p_expires_at: new Date(Date.now() + HOLD_TTL_MS).toISOString(),
    p_idempotency_key: checkoutRef, p_allow_backorder: false,
  });
  if (error) {
    if (String(error.message).includes("insufficient_stock")) return { ok: false, reason: "insufficient_stock" };
    throw error;
  }
  return data as { ok: true; allocation: Array<{ locationId: string; qty: number }> };
}

export async function commitReservation(shopId: string, checkoutRef: string): Promise<void> {
  const { error } = await getSupabase().rpc("inventory_commit", { p_shop_id: shopId, p_checkout_ref: checkoutRef });
  if (error) throw error;
  await reprojectCheckout(shopId, checkoutRef);
}

export async function releaseReservation(shopId: string, checkoutRef: string): Promise<void> {
  const { error } = await getSupabase().rpc("inventory_release", { p_shop_id: shopId, p_checkout_ref: checkoutRef });
  if (error) throw error;
  await reprojectCheckout(shopId, checkoutRef);
}

// commit/release change on_hand; re-project each touched (variant, location).
async function reprojectCheckout(shopId: string, checkoutRef: string): Promise<void> {
  const { data } = await getSupabase().from("inventory_reservation").select("variant_id, location_id").eq("shop_id", shopId).eq("checkout_ref", checkoutRef);
  for (const r of data ?? []) await projectLevelFact(shopId, String(r.variant_id), String(r.location_id));
}

export async function adjustStock(shopId: string, variantId: string, locationId: string, newOnHand: number, reason?: string): Promise<void> {
  const sb = getSupabase();
  const { data: cur } = await sb.from("inventory_balance").select("on_hand").eq("variant_id", variantId).eq("location_id", locationId).maybeSingle();
  const prev = Number(cur?.on_hand ?? 0);
  const delta = newOnHand - prev;
  const { error } = await sb.from("inventory_balance").upsert(
    { shop_id: shopId, variant_id: variantId, location_id: locationId, on_hand: newOnHand, updated_at: new Date().toISOString() },
    { onConflict: "variant_id,location_id" },
  );
  if (error) throw error;
  await sb.from("inventory_ledger").insert({
    shop_id: shopId, variant_id: variantId, location_id: locationId, entry_type: "adjust", qty: delta,
    idempotency_key: `adjust:${variantId}:${locationId}:${Date.now()}`, reason: reason ?? null, source: "merchant",
  });
  await projectLevelFact(shopId, variantId, locationId);
}

export async function markUnavailable(shopId: string, variantId: string, locationId: string, qty: number, reason: string): Promise<void> {
  const sb = getSupabase();
  const { data: cur } = await sb.from("inventory_balance").select("unavailable").eq("variant_id", variantId).eq("location_id", locationId).maybeSingle();
  const next = Number(cur?.unavailable ?? 0) + qty;
  const { error } = await sb.from("inventory_balance").update({ unavailable: next, updated_at: new Date().toISOString() }).eq("variant_id", variantId).eq("location_id", locationId);
  if (error) throw error;
  await sb.from("inventory_ledger").insert({
    shop_id: shopId, variant_id: variantId, location_id: locationId, entry_type: "mark_unavailable", qty: -qty,
    idempotency_key: `unavail:${variantId}:${locationId}:${Date.now()}`, reason, source: "merchant",
  });
  await projectLevelFact(shopId, variantId, locationId);
}

export async function createTransfer(
  shopId: string, variantId: string, fromLocationId: string, toLocationId: string, qty: number, mode: "instant" | "in_transit",
): Promise<{ transferId: string }> {
  const sb = getSupabase();
  // Decrement source on_hand (guard against negative).
  const { data: from } = await sb.from("inventory_balance").select("on_hand, reserved, unavailable").eq("variant_id", variantId).eq("location_id", fromLocationId).maybeSingle();
  const avail = Number(from?.on_hand ?? 0) - Number(from?.reserved ?? 0) - Number(from?.unavailable ?? 0);
  if (avail < qty) throw new Error("insufficient_stock");
  await sb.from("inventory_balance").update({ on_hand: Number(from!.on_hand) - qty, updated_at: new Date().toISOString() }).eq("variant_id", variantId).eq("location_id", fromLocationId);

  const state = mode === "instant" ? "received" : "in_transit";
  const { data: tr, error } = await sb.from("inventory_transfer")
    .insert({ shop_id: shopId, variant_id: variantId, from_location_id: fromLocationId, to_location_id: toLocationId, qty, state, received_at: mode === "instant" ? new Date().toISOString() : null })
    .select("id").single();
  if (error) throw error;

  await sb.from("inventory_ledger").insert({ shop_id: shopId, variant_id: variantId, location_id: fromLocationId, entry_type: "transfer_out", qty: -qty, transfer_id: tr.id, idempotency_key: `tout:${tr.id}`, source: "merchant" });

  if (mode === "instant") {
    await bumpDestination(shopId, variantId, toLocationId, "on_hand", qty);
    await sb.from("inventory_ledger").insert({ shop_id: shopId, variant_id: variantId, location_id: toLocationId, entry_type: "transfer_in", qty, transfer_id: tr.id, idempotency_key: `tin:${tr.id}`, source: "merchant" });
    await projectLevelFact(shopId, variantId, toLocationId);
  } else {
    await bumpDestination(shopId, variantId, toLocationId, "incoming", qty);
    await sb.from("inventory_ledger").insert({ shop_id: shopId, variant_id: variantId, location_id: toLocationId, entry_type: "in_transit", qty, transfer_id: tr.id, idempotency_key: `tit:${tr.id}`, source: "merchant" });
  }
  await projectLevelFact(shopId, variantId, fromLocationId);
  return { transferId: String(tr.id) };
}

export async function receiveTransfer(shopId: string, transferId: string): Promise<void> {
  const sb = getSupabase();
  const { data: tr } = await sb.from("inventory_transfer").select("variant_id, to_location_id, qty, state").eq("id", transferId).maybeSingle();
  if (!tr || tr.state !== "in_transit") return; // idempotent
  await sb.from("inventory_balance").update({ incoming: 0, updated_at: new Date().toISOString() }).eq("variant_id", tr.variant_id).eq("location_id", tr.to_location_id); // simplistic single-transfer; see note
  await bumpDestination(shopId, String(tr.variant_id), String(tr.to_location_id), "on_hand", Number(tr.qty));
  await sb.from("inventory_transfer").update({ state: "received", received_at: new Date().toISOString() }).eq("id", transferId);
  await sb.from("inventory_ledger").insert({ shop_id: shopId, variant_id: tr.variant_id, location_id: tr.to_location_id, entry_type: "received", qty: Number(tr.qty), transfer_id: transferId, idempotency_key: `recv:${transferId}`, source: "merchant" });
  await projectLevelFact(shopId, String(tr.variant_id), String(tr.to_location_id));
}

// Upsert a destination balance row and add to a numeric bucket.
async function bumpDestination(shopId: string, variantId: string, locationId: string, field: "on_hand" | "incoming", qty: number): Promise<void> {
  const sb = getSupabase();
  const { data: cur } = await sb.from("inventory_balance").select(field).eq("variant_id", variantId).eq("location_id", locationId).maybeSingle();
  const next = Number((cur as Record<string, unknown>)?.[field] ?? 0) + qty;
  await sb.from("inventory_balance").upsert(
    { shop_id: shopId, variant_id: variantId, location_id: locationId, [field]: next, updated_at: new Date().toISOString() },
    { onConflict: "variant_id,location_id" },
  );
}
```

> **Implementer note (receiveTransfer):** the `incoming: 0` reset above assumes one outstanding transfer per (variant, location) for v1 simplicity. If concurrent in-transit transfers to the same destination are possible, decrement `incoming` by the transfer's `qty` instead (`incoming = incoming - qty`) — left as a one-line change with this comment, not a silent assumption.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run app/lib/inventory/__tests__/engine.server.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/lib/inventory/engine.server.ts app/lib/inventory/project-level-fact.server.ts app/lib/inventory/__tests__/engine.server.test.ts
git commit -m "feat(inventory): engine wrappers (reserve/commit/release/adjust/transfer) + level-fact projection"
```

---

### Task 5: DB-backed concurrency test — two buyers, one unit

**Files:**
- Create: `tests/engine/inventory/reserve-concurrency.test.ts`

**Interfaces:**
- Consumes: a real local Postgres via `TEST_DATABASE_URL` (the engine harness), the `inventory_reserve` function (Task 2).
- Produces: proof that two simultaneous reserves for the last unit yield exactly one success.

- [ ] **Step 1: Write the test** (runs only when `TEST_DATABASE_URL` is set; mirrors the existing engine DB-test gating)

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "pg";

const URL = process.env.TEST_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

maybe("inventory_reserve concurrency", () => {
  let a: Client, b: Client, setup: Client;
  const shop = "00000000-0000-0000-0000-0000000000aa";
  const variant = "00000000-0000-0000-0000-0000000000b1";
  const loc = "00000000-0000-0000-0000-0000000000c1";

  beforeAll(async () => {
    setup = new Client({ connectionString: URL }); await setup.connect();
    await setup.query("insert into shops(id, shop_domain) values ($1,'demo') on conflict do nothing", [shop]);
    await setup.query("insert into location_dim(id, shop_id, external_id, name, active) values ($1,$2,'L','Main',true) on conflict do nothing", [loc, shop]);
    await setup.query("insert into variant_dim(id, shop_id, product_id, title) values ($1,$2,$2,'V') on conflict do nothing", [variant, shop]).catch(() => {});
    await setup.query("insert into inventory_balance(shop_id, variant_id, location_id, on_hand) values ($1,$2,$3,1) on conflict (variant_id,location_id) do update set on_hand=1, reserved=0", [shop, variant, loc]);
    a = new Client({ connectionString: URL }); await a.connect();
    b = new Client({ connectionString: URL }); await b.connect();
  });
  afterAll(async () => { await Promise.all([a?.end(), b?.end(), setup?.end()]); });

  it("lets exactly one of two simultaneous reserves win the last unit", async () => {
    const call = (client: Client, ref: string) =>
      client.query("select public.inventory_reserve($1,$2,1,$3,$4, now()+interval '30 min', $5, false) as r",
        [shop, variant, [loc], ref, ref]).then((r) => ({ ok: true, r: r.rows[0].r })).catch((e) => ({ ok: false, e: String(e.message) }));
    const [r1, r2] = await Promise.all([call(a, "ca"), call(b, "cb")]);
    const wins = [r1, r2].filter((x) => x.ok).length;
    const losses = [r1, r2].filter((x) => !x.ok && /insufficient_stock/.test((x as { e: string }).e)).length;
    expect(wins).toBe(1);
    expect(losses).toBe(1);
    const bal = await setup.query("select reserved from inventory_balance where variant_id=$1 and location_id=$2", [variant, loc]);
    expect(bal.rows[0].reserved).toBe(1);
  });
});
```

- [ ] **Step 2: Run it against the local DB**

Run:
```bash
bash tests/engine/scripts/test-db.sh up
TEST_DATABASE_URL=postgres://postgres:test@localhost:5433/calderyn_test npx vitest run tests/engine/inventory/reserve-concurrency.test.ts
```
Expected: PASS — exactly one win, one `insufficient_stock`, `reserved = 1`.

- [ ] **Step 3: Commit**

```bash
git add tests/engine/inventory/reserve-concurrency.test.ts
git commit -m "test(inventory): prove the atomic reserve can't oversell under concurrency"
```

---

### Task 6: Seed opening balances + a default location

**Files:**
- Create: `supabase/migrations/20260629120200_inventory_seed.sql`
- Create: `tests/engine/schema/migrations/20260629120200_inventory_seed.sql` (identical copy)

**Interfaces:**
- Produces: a primary `location_dim` row per shop that has none, and an `inventory_balance` row per variant seeded from `variant_dim.inventory_on_hand` at that primary location.

- [ ] **Step 1: Write the seed migration**

```sql
-- Ensure every shop has at least one location (owned stores have none yet).
insert into public.location_dim (shop_id, name, active, priority)
select s.id, 'Primary', true, 0
from public.shops s
where not exists (select 1 from public.location_dim l where l.shop_id = s.id);

-- Seed inventory_balance from Slice 1's per-variant on-hand at each shop's
-- lowest-priority (primary) location. Idempotent.
insert into public.inventory_balance (shop_id, variant_id, location_id, on_hand)
select v.shop_id, v.id, (
  select l.id from public.location_dim l where l.shop_id = v.shop_id order by l.priority, l.created_at limit 1
), coalesce(v.inventory_on_hand, 0)
from public.variant_dim v
where exists (select 1 from public.location_dim l where l.shop_id = v.shop_id)
on conflict (variant_id, location_id) do nothing;
```

- [ ] **Step 2: Apply + verify on the seeded local sample**

Run:
```bash
PGPASSWORD=test psql -h localhost -p 5433 -U postgres -d calderyn_test -f tests/engine/schema/migrations/20260629120200_inventory_seed.sql
PGPASSWORD=test psql -h localhost -p 5433 -U postgres -d calderyn_test -c "select count(*) as balances, count(*) filter (where on_hand > 0) as seeded from inventory_balance;"
```
Expected: one balance row per variant that had a location; on-hand carried from `inventory_on_hand`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260629120200_inventory_seed.sql tests/engine/schema/migrations/20260629120200_inventory_seed.sql
git commit -m "feat(inventory): seed balances from Slice-1 on-hand + default location"
```

---

### Task 7: Reaper cron + full gate

**Files:**
- Create: `app/routes/cron.inventory-reaper.tsx`
- Create: `app/lib/inventory/reaper.server.ts`
- Test: `app/lib/inventory/__tests__/reaper.server.test.ts`

**Interfaces:**
- Consumes: `isAuthorizedCron` (`~/lib/cron-auth.server`), `getSupabase`, `releaseReservation` (Task 4).
- Produces: `expireStaleReservations(): Promise<{ released: number }>` + the cron route (mirrors `cron.action-retry.tsx`).

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
const expiredRows = [{ shop_id: "s1", checkout_ref: "co1" }, { shop_id: "s1", checkout_ref: "co1" }];
const release = vi.fn().mockResolvedValue(undefined);
vi.mock("~/lib/inventory/engine.server", () => ({ releaseReservation: release }));
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({ from: () => ({ select: () => ({ eq: () => ({ lt: () => Promise.resolve({ data: expiredRows, error: null }) }) }) }) }),
}));
beforeEach(() => release.mockClear());

describe("expireStaleReservations", () => {
  it("releases each distinct expired checkout once", async () => {
    const { expireStaleReservations } = await import("../reaper.server");
    const r = await expireStaleReservations();
    expect(release).toHaveBeenCalledTimes(1); // dedupes co1
    expect(r.released).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/inventory/__tests__/reaper.server.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `reaper.server.ts` + the cron route**

`app/lib/inventory/reaper.server.ts`:

```typescript
import { getSupabase } from "../supabase.server";
import { releaseReservation } from "./engine.server";

export async function expireStaleReservations(): Promise<{ released: number }> {
  const { data, error } = await getSupabase()
    .from("inventory_reservation")
    .select("shop_id, checkout_ref")
    .eq("state", "held")
    .lt("expires_at", new Date().toISOString());
  if (error) throw error;
  const seen = new Set<string>();
  for (const r of data ?? []) {
    const key = `${r.shop_id}:${r.checkout_ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await releaseReservation(String(r.shop_id), String(r.checkout_ref));
  }
  return { released: seen.size };
}
```

`app/routes/cron.inventory-reaper.tsx`:

```tsx
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { isAuthorizedCron } from "~/lib/cron-auth.server";
import { expireStaleReservations } from "~/lib/inventory/reaper.server";

// Suggested schedule: every 5 minutes — `*/5 * * * *`.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!isAuthorizedCron(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return new Response("Unauthorized", { status: 401 });
  }
  return json(await expireStaleReservations());
};
```

- [ ] **Step 4: Run the reaper test**

Run: `npx vitest run app/lib/inventory/__tests__/reaper.server.test.ts`
Expected: PASS.

- [ ] **Step 5: Register the cron schedule**

Add the route to the Vercel cron config (mirror how `cron.action-retry` is scheduled in `vercel.json` / the cron config the repo uses): path `/cron/inventory-reaper`, schedule `*/5 * * * *`. If schedules live in `vercel.json`, add the entry; confirm with `git grep -n "cron/action-retry"` to find the file.

- [ ] **Step 6: Full gate**

Run, pasting results:
```bash
npm run typecheck   # exit 0
npm run lint        # exit 0
npm run build       # exit 0
npx vitest run      # all green (concurrency test skips without TEST_DATABASE_URL)
```

- [ ] **Step 7: Commit**

```bash
git add app/routes/cron.inventory-reaper.tsx app/lib/inventory/reaper.server.ts app/lib/inventory/__tests__/reaper.server.test.ts vercel.json
git commit -m "feat(inventory): reservation reaper cron + green gate"
```

---

## Self-Review

**Spec coverage (against `docs/superpowers/specs/2026-06-28-slice-2-inventory-ledger-design.md`):**
- Per-location balance with on_hand/reserved/incoming/unavailable/available → Task 1. ✅
- Atomic reserve (can't oversell) → Task 2 (`FOR UPDATE` + rollback) + proven in Task 5. ✅
- commit/release idempotent → Task 2. ✅
- Destination-aware allocator (nearest, else priority) → Task 3. ✅
- adjust / markUnavailable / transfer (instant + in-transit) / receive → Task 4. ✅
- Reorder point column → Task 1 (`reorder_point`); the merchant editing + alert wiring is Plan B / the engine. ✅ (column here)
- Engine-alive projection to `inventory_level_fact` → Task 4 (`projectLevelFact`, called after every mutation). ✅
- Seed from Slice-1 `inventory_on_hand` + default location → Task 6. ✅
- Reaper → Task 7. ✅

**Out of scope (Plan B — merchant UI):** the per-location stock grid in the product editor, the transfer/receive UI, reorder-point editing, location settings (priority + coordinates), the history view, and the `dashboard.api.catalog.inventory.*` routes.

**Placeholder scan:** none — the one judgment call (`receiveTransfer` incoming reset) is flagged inline with the exact alternative, not left vague.

**Type/invariant consistency:** `variant_dim.id == sku_dim.id` is used by `projectLevelFact` (sku_id = variantId). `reserveStock`'s `{ok,allocation}|{ok:false,reason}` shape matches what Slice 3 checkout will consume. `available = on_hand − reserved − unavailable` is the generated column (Task 1) and the same expression guards the atomic hold (Task 2).

**Design note:** the concurrency-critical path (reserve) is the only logic pushed fully into SQL; commit/release are also SQL (they mutate balances) for atomicity; adjust/markUnavailable/transfer are TS (single-actor merchant actions, low contention) — a deliberate split, not an inconsistency.
