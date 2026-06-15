# True Ship Cost — Plan 1: Cost-Engine Foundation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a trustworthy per-order `ship_cost` (stamped with provenance + confidence) and subtract it from contribution margin, for every merchant.

**Architecture:** New `ship_cost_*` columns on `order_fact`, weight on `order_line_fact`/`sku_dim`, and two anchor tables (`shipping_cost_period`, `shipping_invoice_line`). A pure, unit-tested `app/lib/ship-cost/` module resolves each order top-down (manual > invoice > event > allocated > modeled > fallback), where the Mode-B allocation distributes the merchant's known period total across orders by weight×zone so it sums to the real total. A runner writes results to `order_fact` and rolls them into `sku_pnl`.

**Tech Stack:** Remix + TypeScript, Supabase (Postgres) via `@supabase/supabase-js`, Vitest, Shopify Admin GraphQL ingest.

**Frozen contract (shared by Plans 2 & 3 — do not rename):**
- Columns: `order_fact.ship_cost_cents`, `.ship_cost_source`, `.ship_cost_confidence`, `.ship_cost_reconciled_at`; `order_line_fact.grams`; `sku_dim.grams`.
- Tables: `shipping_cost_period(id, shop_id, period_start, period_end, carrier, total_cents, source, created_at)`, `shipping_invoice_line(id, shop_id, period_id, order_ref, tracking_no, cost_cents, matched_order_id, created_at)`.
- Types in `app/lib/ship-cost/types.ts`: `ShipCostSource`, `ShipCostConfidence`, `ShipCostResult`, `OrderSignals`.
- Functions: `classifyZone()`, `zoneMultiplier()` (`zone.ts`); `allocatePeriodTotal()` (`allocate.ts`); `splitOrderShipCost()` (`split.ts`); `resolveOrderShipCost()` (`resolve.ts`); `runShipCostResolution()` (`runner.server.ts`).

---

## Task 1: Migration — ship-cost columns + anchor tables

**Files:**
- Create: `supabase/migrations/20260615120000_true_ship_cost.sql`

- [ ] **Step 1: Write the migration SQL**

```sql
-- True Ship Cost foundation: per-order resolved ship cost + weight + anchors.
-- text+CHECK (not enum types) so phase-2 'actual_3pl' needs no ALTER TYPE.
alter table public.order_fact
  add column if not exists ship_cost_cents integer,
  add column if not exists ship_cost_source text
    check (ship_cost_source in
      ('actual_invoice','actual_event','reconciled','modeled','fallback','manual')),
  add column if not exists ship_cost_confidence text
    check (ship_cost_confidence in ('high','med','low')),
  add column if not exists ship_cost_reconciled_at timestamptz;

alter table public.order_line_fact add column if not exists grams integer;
alter table public.sku_dim         add column if not exists grams integer;

create table if not exists public.shipping_cost_period (
  id           uuid primary key default gen_random_uuid(),
  shop_id      uuid not null,
  period_start date not null,
  period_end   date not null,
  carrier      text,
  total_cents  bigint not null,
  source       text not null check (source in ('upload','typed')),
  created_at   timestamptz not null default now()
);
create index if not exists shipping_cost_period_shop_idx
  on public.shipping_cost_period (shop_id, period_start, period_end);

create table if not exists public.shipping_invoice_line (
  id              uuid primary key default gen_random_uuid(),
  shop_id         uuid not null,
  period_id       uuid references public.shipping_cost_period(id) on delete cascade,
  order_ref       text,
  tracking_no     text,
  cost_cents      integer not null,
  matched_order_id uuid references public.order_fact(id) on delete set null,
  created_at      timestamptz not null default now()
);
create index if not exists shipping_invoice_line_shop_idx
  on public.shipping_invoice_line (shop_id, period_id);

alter table public.shipping_cost_period   enable row level security;
alter table public.shipping_invoice_line  enable row level security;
```

- [ ] **Step 2: Apply to a Supabase dev branch and verify**

Apply via the Supabase MCP `apply_migration` (name `true_ship_cost`) against a dev branch, then confirm columns exist:

Run (MCP `execute_sql`):
```sql
select column_name from information_schema.columns
where table_name='order_fact' and column_name like 'ship_cost%';
```
Expected: 4 rows (`ship_cost_cents`, `ship_cost_source`, `ship_cost_confidence`, `ship_cost_reconciled_at`).

- [ ] **Step 3: Add RLS policies matching the repo's shop-scoped pattern**

Mirror an existing per-shop policy (see `20260601010000_integration_credentials.sql` for the `shop_id`-scoped template) for both new tables. Append to the same migration file.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260615120000_true_ship_cost.sql
git commit -m "supabase: true ship cost schema — order_fact ship_cost cols, grams, anchor tables"
```

---

## Task 2: Ingest line-item weight (`grams`)

**Files:**
- Modify: `app/lib/ingest/shopify-admin.server.ts` (order lineItems query + `AdminOrder` type)
- Modify: `app/lib/ingest/mappers.server.ts` (line mapping)
- Modify: `app/lib/ingest/types.ts` (add `grams` to the line DTO)
- Test: `app/lib/ingest/__tests__/mappers.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("maps line-item grams from the admin payload", () => {
  const line = mapOrderLine({
    id: "gid://shopify/LineItem/1",
    quantity: 2,
    variant: { id: "gid://shopify/ProductVariant/9" },
    grams: 450,
    originalUnitPriceSet: { shopMoney: { amount: "20.00" } },
  });
  expect(line.grams).toBe(450);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/ingest/__tests__/mappers.test.ts -t "grams"`
Expected: FAIL (`grams` undefined / not on type).

- [ ] **Step 3: Add `grams` to the GraphQL query, type, DTO, and mapper**

In `shopify-admin.server.ts`, the order lineItems selection (currently `nodes { id quantity variant { id } originalUnitPriceSet { shopMoney { amount } } }`) gains `grams`:
```graphql
nodes { id quantity grams variant { id } originalUnitPriceSet { shopMoney { amount } } }
```
Add `grams: number | null` to the `AdminOrder` lineItems node type. In `types.ts` add `grams: number | null` to the order-line DTO. In `mappers.server.ts`:
```ts
grams: node.grams ?? null,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/ingest/__tests__/mappers.test.ts -t "grams"`
Expected: PASS.

- [ ] **Step 5: Persist `grams` into `order_line_fact`**

In the ingest writer that upserts order lines (the function that writes `order_line_fact`), add `grams` to the upserted columns. Add an assertion to the existing writer test that `grams` is included in the upsert payload.

- [ ] **Step 6: Commit**

```bash
git add app/lib/ingest
git commit -m "ingest: capture line-item grams into order_line_fact"
```

---

## Task 3: Ship-cost types

**Files:**
- Create: `app/lib/ship-cost/types.ts`

- [ ] **Step 1: Write the types**

```ts
export type ShipCostSource =
  | "actual_invoice"
  | "actual_event"
  | "reconciled"
  | "modeled"
  | "fallback"
  | "manual";

export type ShipCostConfidence = "high" | "med" | "low";

export interface ShipCostResult {
  cents: number;
  source: ShipCostSource;
  confidence: ShipCostConfidence;
}

/** Per-order candidate signals, highest-fidelity first. Undefined/null = absent. */
export interface OrderSignals {
  manualOverrideCents?: number | null;
  invoiceLineCents?: number | null;
  /** Only populated if the parse already reconciled under the period total. */
  eventParsedCents?: number | null;
  /** Mode-B allocation result for this order; null when no period total exists. */
  allocatedCents?: number | null;
  /** Generic per-zone default when no period total at all. */
  modeledCents?: number | null;
  /** Flat floor (period_total / orders, or category default). Always present. */
  fallbackCents: number;
  /** Feature coverage behind allocatedCents, drives confidence. */
  allocationCoverage?: "full" | "partial" | "none";
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add app/lib/ship-cost/types.ts
git commit -m "ship-cost: source/confidence/result/signals types"
```

---

## Task 4: Zone classification + multiplier

**Files:**
- Create: `app/lib/ship-cost/zone.ts`
- Test: `app/lib/ship-cost/__tests__/zone.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { classifyZone, zoneMultiplier } from "../zone";

describe("zone", () => {
  it("same country is domestic", () => {
    expect(classifyZone("US", "US")).toBe("domestic");
  });
  it("US→CA is continental", () => {
    expect(classifyZone("US", "CA")).toBe("continental");
  });
  it("US→JP is international", () => {
    expect(classifyZone("US", "JP")).toBe("international");
  });
  it("unknown origin or dest falls back to domestic multiplier 1", () => {
    expect(zoneMultiplier(classifyZone(null, null))).toBe(1);
  });
  it("multipliers increase with distance", () => {
    expect(zoneMultiplier("domestic")).toBeLessThan(zoneMultiplier("continental"));
    expect(zoneMultiplier("continental")).toBeLessThan(zoneMultiplier("international"));
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run app/lib/ship-cost/__tests__/zone.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
export type Zone = "domestic" | "continental" | "international";

// North-America bloc for the coarse continental bucket. Default v1 buckets;
// merchant-tunable later (Plan 2).
const CONTINENTAL = new Set(["US", "CA", "MX"]);

export function classifyZone(
  shopCountry: string | null,
  orderCountry: string | null,
): Zone {
  if (!shopCountry || !orderCountry) return "domestic";
  if (shopCountry === orderCountry) return "domestic";
  if (CONTINENTAL.has(shopCountry) && CONTINENTAL.has(orderCountry)) {
    return "continental";
  }
  return "international";
}

export function zoneMultiplier(zone: Zone): number {
  switch (zone) {
    case "domestic":
      return 1;
    case "continental":
      return 1.6;
    case "international":
      return 3;
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run app/lib/ship-cost/__tests__/zone.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/ship-cost/zone.ts app/lib/ship-cost/__tests__/zone.test.ts
git commit -m "ship-cost: zone classification + multipliers"
```

---

## Task 5: Allocate period total → orders (sums to total)

**Files:**
- Create: `app/lib/ship-cost/allocate.ts`
- Test: `app/lib/ship-cost/__tests__/allocate.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { allocatePeriodTotal, type AllocOrder } from "../allocate";

const o = (id: string, grams: number | null, itemCount: number, zm = 1): AllocOrder => ({
  orderId: id, grams, itemCount, zoneMultiplier: zm, fulfillmentCount: 1,
});

describe("allocatePeriodTotal", () => {
  it("sums exactly to the period total (no cents lost to rounding)", () => {
    const m = allocatePeriodTotal([o("a", 100, 1), o("b", 200, 1), o("c", 33, 1)], 10000);
    expect([...m.values()].reduce((s, v) => s + v, 0)).toBe(10000);
  });
  it("allocates by weight when grams present", () => {
    const m = allocatePeriodTotal([o("a", 100, 1), o("b", 300, 1)], 8000);
    expect(m.get("b")!).toBeGreaterThan(m.get("a")!); // heavier order pays more
  });
  it("falls back to item count when any order lacks grams", () => {
    const m = allocatePeriodTotal([o("a", null, 1), o("b", null, 3)], 8000);
    expect(m.get("b")!).toBe(6000);
    expect(m.get("a")!).toBe(2000);
  });
  it("zone multiplier scales the share", () => {
    const m = allocatePeriodTotal([o("a", 100, 1, 1), o("b", 100, 1, 3)], 8000);
    expect(m.get("b")!).toBe(6000);
  });
  it("empty orders returns empty map", () => {
    expect(allocatePeriodTotal([], 5000).size).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run app/lib/ship-cost/__tests__/allocate.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement (largest-remainder rounding so it sums to total)**

```ts
export interface AllocOrder {
  orderId: string;
  grams: number | null;
  itemCount: number;
  zoneMultiplier: number;
  fulfillmentCount: number;
}

export function allocatePeriodTotal(
  orders: AllocOrder[],
  totalCents: number,
): Map<string, number> {
  const out = new Map<string, number>();
  if (orders.length === 0) return out;

  const useWeight = orders.every((o) => o.grams != null && o.grams > 0);
  const weightOf = (o: AllocOrder) =>
    (useWeight ? (o.grams as number) : Math.max(o.itemCount, 1)) *
    o.zoneMultiplier *
    Math.max(o.fulfillmentCount, 1);

  const weights = orders.map(weightOf);
  const sum = weights.reduce((s, w) => s + w, 0) || orders.length;

  // Floor each, then hand out the leftover cents by largest fractional part.
  const raw = orders.map((o, i) => (totalCents * weights[i]) / sum);
  const floored = raw.map(Math.floor);
  let remainder = totalCents - floored.reduce((s, v) => s + v, 0);
  const order = raw
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < order.length && remainder > 0; k++, remainder--) {
    floored[order[k].i] += 1;
  }
  orders.forEach((o, i) => out.set(o.orderId, floored[i]));
  return out;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run app/lib/ship-cost/__tests__/allocate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/ship-cost/allocate.ts app/lib/ship-cost/__tests__/allocate.test.ts
git commit -m "ship-cost: period-total allocation by weight/zone, sums to total"
```

---

## Task 6: Split an order's ship cost across its lines

**Files:**
- Create: `app/lib/ship-cost/split.ts`
- Test: `app/lib/ship-cost/__tests__/split.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { splitOrderShipCost, type SplitLine } from "../split";

describe("splitOrderShipCost", () => {
  it("splits by weight share and sums to the order cost", () => {
    const m = splitOrderShipCost(1000, [
      { lineId: "x", grams: 100, quantity: 1 },
      { lineId: "y", grams: 300, quantity: 1 },
    ]);
    expect(m.get("y")!).toBe(750);
    expect(m.get("x")!).toBe(250);
    expect([...m.values()].reduce((s, v) => s + v, 0)).toBe(1000);
  });
  it("falls back to quantity when weights missing", () => {
    const m = splitOrderShipCost(900, [
      { lineId: "x", grams: null, quantity: 1 },
      { lineId: "y", grams: null, quantity: 2 },
    ]);
    expect(m.get("y")!).toBe(600);
    expect(m.get("x")!).toBe(300);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run app/lib/ship-cost/__tests__/split.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement (reuse largest-remainder logic)**

```ts
export interface SplitLine {
  lineId: string;
  grams: number | null;
  quantity: number;
}

export function splitOrderShipCost(
  orderShipCostCents: number,
  lines: SplitLine[],
): Map<string, number> {
  const out = new Map<string, number>();
  if (lines.length === 0) return out;
  const useWeight = lines.every((l) => l.grams != null && l.grams > 0);
  const weightOf = (l: SplitLine) =>
    useWeight ? (l.grams as number) : Math.max(l.quantity, 1);
  const weights = lines.map(weightOf);
  const sum = weights.reduce((s, w) => s + w, 0) || lines.length;
  const raw = lines.map((_, i) => (orderShipCostCents * weights[i]) / sum);
  const floored = raw.map(Math.floor);
  let rem = orderShipCostCents - floored.reduce((s, v) => s + v, 0);
  const ord = raw
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < ord.length && rem > 0; k++, rem--) floored[ord[k].i] += 1;
  lines.forEach((l, i) => out.set(l.lineId, floored[i]));
  return out;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run app/lib/ship-cost/__tests__/split.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/ship-cost/split.ts app/lib/ship-cost/__tests__/split.test.ts
git commit -m "ship-cost: split order ship cost across lines by weight/qty"
```

---

## Task 7: Resolve routing precedence + confidence

**Files:**
- Create: `app/lib/ship-cost/resolve.ts`
- Test: `app/lib/ship-cost/__tests__/resolve.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { resolveOrderShipCost } from "../resolve";

const base = { fallbackCents: 500 } as const;

describe("resolveOrderShipCost", () => {
  it("manual override wins over everything", () => {
    const r = resolveOrderShipCost({ ...base, manualOverrideCents: 700, invoiceLineCents: 100, allocatedCents: 200 });
    expect(r).toEqual({ cents: 700, source: "manual", confidence: "high" });
  });
  it("invoice beats event and allocation", () => {
    const r = resolveOrderShipCost({ ...base, invoiceLineCents: 450, eventParsedCents: 480, allocatedCents: 600 });
    expect(r.source).toBe("actual_invoice");
    expect(r.confidence).toBe("high");
  });
  it("event (reconciled) beats allocation", () => {
    const r = resolveOrderShipCost({ ...base, eventParsedCents: 480, allocatedCents: 600 });
    expect(r).toEqual({ cents: 480, source: "actual_event", confidence: "med" });
  });
  it("allocation confidence tracks coverage", () => {
    expect(resolveOrderShipCost({ ...base, allocatedCents: 600, allocationCoverage: "full" }).confidence).toBe("high");
    expect(resolveOrderShipCost({ ...base, allocatedCents: 600, allocationCoverage: "partial" }).confidence).toBe("med");
  });
  it("modeled then fallback when no total", () => {
    expect(resolveOrderShipCost({ ...base, modeledCents: 550 }).source).toBe("modeled");
    expect(resolveOrderShipCost({ ...base }).source).toBe("fallback");
    expect(resolveOrderShipCost({ ...base }).confidence).toBe("low");
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run app/lib/ship-cost/__tests__/resolve.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
import type { OrderSignals, ShipCostResult } from "./types";

export function resolveOrderShipCost(s: OrderSignals): ShipCostResult {
  if (s.manualOverrideCents != null)
    return { cents: s.manualOverrideCents, source: "manual", confidence: "high" };
  if (s.invoiceLineCents != null)
    return { cents: s.invoiceLineCents, source: "actual_invoice", confidence: "high" };
  if (s.eventParsedCents != null)
    return { cents: s.eventParsedCents, source: "actual_event", confidence: "med" };
  if (s.allocatedCents != null) {
    const confidence =
      s.allocationCoverage === "full" ? "high"
      : s.allocationCoverage === "none" ? "low"
      : "med";
    return { cents: s.allocatedCents, source: "reconciled", confidence };
  }
  if (s.modeledCents != null)
    return { cents: s.modeledCents, source: "modeled", confidence: "low" };
  return { cents: s.fallbackCents, source: "fallback", confidence: "low" };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run app/lib/ship-cost/__tests__/resolve.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/ship-cost/resolve.ts app/lib/ship-cost/__tests__/resolve.test.ts
git commit -m "ship-cost: resolve routing precedence + confidence tiers"
```

---

## Task 8: Wire `ship_cost` into the contribution-margin formula

**Files:**
- Modify: `app/lib/seed/dataset.ts` (the `n_cents` computation)
- Modify: `app/lib/seed/types.ts` (add `ship_cost_cents` to the PnL row)
- Test: `app/lib/seed/__tests__/dataset.test.ts`
- Migration: `supabase/migrations/20260615120100_v_campaigns_flat_ship_cost.sql`

- [ ] **Step 1: Write the failing test**

```ts
it("subtracts ship_cost from contribution margin", () => {
  // a slot with revenue 10000, cogs 4000, adSpend 1000, returns 0, ship 700
  // → 10000 - 4000 - 1000 - 0 - 700 = 4300
  const p = pnlForSlot({ revenue: 10000, cogs: 4000, adSpendAttrib: 1000, returns: 0, shipCost: 700 });
  expect(p.n_cents).toBe(4300);
  expect(p.ship_cost_cents).toBe(700);
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run app/lib/seed/__tests__/dataset.test.ts -t "ship_cost"`
Expected: FAIL.

- [ ] **Step 3: Add the ship term**

In `seed/types.ts` add `ship_cost_cents: number;` to the PnL row interface. In `seed/dataset.ts` change:
```ts
n_cents: slot.revenue - slot.cogs - adSpendAttrib - returns - shipCost,
ship_cost_cents: shipCost,
```
where `shipCost` is summed from the slot's allocated order ship costs (0 when unknown).

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run app/lib/seed/__tests__/dataset.test.ts -t "ship_cost"`
Expected: PASS.

- [ ] **Step 5: Adjust `v_campaigns_flat` margin for ship cost**

Fetch the current view definition first:
```sql
select pg_get_viewdef('public.v_campaigns_flat'::regclass, true);
```
Then create the migration that redefines the view so the contribution-margin **numerator** subtracts attributed ship cost — i.e. replace `(revenue - cogs - ad_spend)` in the margin term with `(revenue - cogs - ad_spend - coalesce(ship_cost, 0))`, joining `order_fact.ship_cost_cents` attributed to the campaign on the same key the view already uses for revenue. Keep `security_invoker` per `20260604140000_views_security_invoker.sql`.

- [ ] **Step 6: Commit**

```bash
git add app/lib/seed supabase/migrations/20260615120100_v_campaigns_flat_ship_cost.sql
git commit -m "margin: subtract ship_cost from contribution margin (sku_pnl + v_campaigns_flat)"
```

---

## Task 9: Resolver runner — write `order_fact`, roll into `sku_pnl`

**Files:**
- Create: `app/lib/ship-cost/runner.server.ts`
- Test: `app/lib/ship-cost/__tests__/runner.test.ts`
- Modify: `app/routes/cron.ingest.tsx` (invoke after order ingest)

- [ ] **Step 1: Write the failing test (fake Supabase client)**

```ts
import { runShipCostResolution } from "../runner.server";
import { makeFakeSupabase } from "./helpers"; // returns an in-memory query stub

it("writes ship_cost to order_fact summing to the period total", async () => {
  const sb = makeFakeSupabase({
    order_fact: [
      { id: "a", shop_id: "s", customer_country: "US", grams_sum: 100, item_count: 1, fulfillment_count: 1 },
      { id: "b", shop_id: "s", customer_country: "CA", grams_sum: 300, item_count: 1, fulfillment_count: 1 },
    ],
    shipping_cost_period: [{ shop_id: "s", total_cents: 8000 }],
    shipping_invoice_line: [],
  });
  await runShipCostResolution(sb, "s", { shopCountry: "US" });
  const written = sb.updates("order_fact");
  const total = written.reduce((s, u) => s + u.ship_cost_cents, 0);
  expect(total).toBe(8000);
  expect(written.find((u) => u.id === "a")!.ship_cost_source).toBe("reconciled");
});

it("uses invoice line as actual when present", async () => {
  const sb = makeFakeSupabase({
    order_fact: [{ id: "a", shop_id: "s", customer_country: "US", grams_sum: 100, item_count: 1, fulfillment_count: 1 }],
    shipping_cost_period: [{ shop_id: "s", total_cents: 8000 }],
    shipping_invoice_line: [{ shop_id: "s", matched_order_id: "a", cost_cents: 455 }],
  });
  await runShipCostResolution(sb, "s", { shopCountry: "US" });
  const u = sb.updates("order_fact")[0];
  expect(u.ship_cost_cents).toBe(455);
  expect(u.ship_cost_source).toBe("actual_invoice");
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run app/lib/ship-cost/__tests__/runner.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the runner**

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { classifyZone, zoneMultiplier } from "./zone";
import { allocatePeriodTotal, type AllocOrder } from "./allocate";
import { resolveOrderShipCost } from "./resolve";
import type { OrderSignals } from "./types";

interface RunnerOpts { shopCountry: string | null; }

export async function runShipCostResolution(
  sb: SupabaseClient,
  shopId: string,
  opts: RunnerOpts,
): Promise<void> {
  const { data: orders = [] } = await sb
    .from("order_fact")
    .select("id, customer_country, grams_sum, item_count, fulfillment_count")
    .eq("shop_id", shopId);
  if (orders.length === 0) return;

  const { data: periods = [] } = await sb
    .from("shipping_cost_period").select("total_cents").eq("shop_id", shopId);
  const periodTotal = periods.reduce((s, p) => s + (p.total_cents ?? 0), 0) || null;

  const { data: invoices = [] } = await sb
    .from("shipping_invoice_line")
    .select("matched_order_id, cost_cents").eq("shop_id", shopId);
  const invoiceByOrder = new Map<string, number>();
  for (const i of invoices) if (i.matched_order_id) invoiceByOrder.set(i.matched_order_id, i.cost_cents);

  const allocOrders: AllocOrder[] = orders.map((o) => ({
    orderId: o.id,
    grams: o.grams_sum ?? null,
    itemCount: o.item_count ?? 1,
    zoneMultiplier: zoneMultiplier(classifyZone(opts.shopCountry, o.customer_country)),
    fulfillmentCount: o.fulfillment_count ?? 1,
  }));
  const allocated = periodTotal ? allocatePeriodTotal(allocOrders, periodTotal) : null;
  const coverage: OrderSignals["allocationCoverage"] =
    allocOrders.every((o) => o.grams != null) ? "full"
    : allocOrders.some((o) => o.grams != null) ? "partial" : "none";
  const fallbackFlat = periodTotal ? Math.round(periodTotal / orders.length) : 0;

  const nowIso = new Date().toISOString(); // runner is server-side; ok here
  for (const o of orders) {
    const r = resolveOrderShipCost({
      manualOverrideCents: null,
      invoiceLineCents: invoiceByOrder.get(o.id) ?? null,
      eventParsedCents: null,
      allocatedCents: allocated?.get(o.id) ?? null,
      modeledCents: null,
      fallbackCents: fallbackFlat,
      allocationCoverage: coverage,
    });
    await sb.from("order_fact").update({
      ship_cost_cents: r.cents,
      ship_cost_source: r.source,
      ship_cost_confidence: r.confidence,
      ship_cost_reconciled_at: nowIso,
    }).eq("id", o.id).eq("shop_id", shopId);
  }
}
```
Note: `grams_sum`, `item_count`, `fulfillment_count` come from a select that aggregates `order_line_fact.grams`/`quantity` and counts `fulfillment_fact` per order — add a `v_order_ship_features` view (or select with sub-aggregates) in the same migration as Task 1 if not expressible inline.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run app/lib/ship-cost/__tests__/runner.test.ts`
Expected: PASS.

- [ ] **Step 5: Roll resolved order ship cost into `sku_pnl`**

Add a step (or follow-on function `rollShipCostIntoSkuPnl`) that, per `(sku_id, day)`, sums each order's `ship_cost_cents` split across its lines (via `splitOrderShipCost`) and writes `sku_pnl.ship_cost_cents`, then recomputes `contribution_margin_cents = revenue - cogs - ad_spend_attrib - return - ship_cost`. Add a test asserting the per-SKU margin drops by the allocated ship cost.

- [ ] **Step 6: Invoke from the ingest cron**

In `app/routes/cron.ingest.tsx`, after order ingest completes for a shop, call `runShipCostResolution(sb, shopId, { shopCountry })`. Add a test that the cron handler calls it once per shop.

- [ ] **Step 7: Commit**

```bash
git add app/lib/ship-cost app/routes/cron.ingest.tsx
git commit -m "ship-cost: resolver runner writes order_fact + rolls into sku_pnl; wired into ingest cron"
```

---

## Final verification (pre-commit gate)

- [ ] `npm run typecheck` → exit 0
- [ ] `npm run lint` → exit 0 (`--max-warnings=0` on touched files)
- [ ] `npm run build` → exit 0
- [ ] `npx vitest run app/lib/ship-cost app/lib/ingest app/lib/seed` → all green
- [ ] `npx prisma validate` (only if `prisma/schema.prisma` changed — it should NOT here)
- [ ] Supabase migrations applied to a dev branch and verified before merge to `main`

## Notes for Plans 2 & 3
- Plan 2 supplies `shipping_cost_period` rows (typed/CSV) and `shipping_invoice_line` rows (matched), plus `manualOverrideCents` via a per-order override table → all already consumed by the runner/resolver.
- Plan 3's `free_shipping_leakage` detector reads `order_fact.ship_cost_cents` + `shipping_cents` and `sku_pnl`; it is a new `detector_id` string (no enum migration).
