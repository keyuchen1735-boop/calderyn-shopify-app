# True Ship Cost — Part 2: Merchant Inputs & Surfaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give merchants the Settings inputs (mode, typed period total, CSV invoice upload, per-order override) that feed Plan 1's ship-cost resolver, surface the resolved provenance next to SKU margin, and close Plan 1's manual-override storage gap.

**Architecture:** Pure, unit-tested parse/match/calc helpers in `app/lib/ship-cost/` (CSV parse, invoice→order match, missing-weight %, optional event parse), thin server wrappers in `inputs.server.ts` that write `shipping_cost_period` / `shipping_invoice_line` / `order_fact.ship_cost_manual_cents` then call Plan 1's `runShipCostResolution`, a new "Shipping cost" `Layout.AnnotatedSection` in `app.settings.tsx`, and a provenance `Badge` in `app.skus.tsx`. One additive migration adds the manual-override column the runner was already written to read.

**Tech Stack:** Remix + TypeScript (strict), Supabase (Postgres) via `@supabase/supabase-js`, Shopify Polaris + `@shopify/polaris-icons`, Vitest.

**Frozen contract consumed from Plan 1 (do NOT rename):**
- `order_fact.ship_cost_cents | ship_cost_source | ship_cost_confidence | ship_cost_reconciled_at`; `order_line_fact.grams`; `sku_dim.grams`.
- `shipping_cost_period(id, shop_id, period_start, period_end, carrier, total_cents, source('upload'|'typed'), created_at)`.
- `shipping_invoice_line(id, shop_id, period_id, order_ref, tracking_no, cost_cents, matched_order_id, created_at)`.
- `app/lib/ship-cost/types.ts`: `ShipCostSource`, `ShipCostConfidence`, `OrderSignals`.
- `runShipCostResolution(sb, shopId, { shopCountry })` in `runner.server.ts`.

**New names introduced by Part 2 (defined once, reused exactly):**
- Column: `order_fact.ship_cost_manual_cents integer` (nullable).
- Pure helpers: `parseInvoiceCsv`, `matchInvoiceLines`, `missingWeightPct`, `parseLabelEvents`.
- Server fns (in `app/lib/ship-cost/inputs.server.ts`): `saveTypedPeriodTotal`, `ingestInvoiceCsv`, `setManualOverride`.
- Settings action intents: `set_ship_mode`, `add_period_total`, `upload_invoice_csv`, `set_manual_override`.

---

## Task 1: Migration — manual-override column

**Files:**
- Create: `supabase/migrations/20260615130000_ship_cost_manual_override.sql`

- [ ] **Step 1: Write the migration SQL**

```sql
-- True Ship Cost Part 2: per-order manual ship-cost override.
-- Plan 1's resolver already reads OrderSignals.manualOverrideCents (highest
-- precedence) but Plan 1 added no storage for it. This nullable column is that
-- storage; the runner (Task 2) reads it. Additive + idempotent so it is safe to
-- apply independently. order_fact already has RLS from Plan 1's migration; a new
-- nullable column inherits it, so no policy change is needed.
alter table public.order_fact
  add column if not exists ship_cost_manual_cents integer;
```

- [ ] **Step 2: Apply to a Supabase dev branch and verify**

Apply via the Supabase MCP `apply_migration` (name `ship_cost_manual_override`) against a dev branch, then confirm the column exists (MCP `execute_sql`):
```sql
select column_name, is_nullable, data_type from information_schema.columns
where table_name='order_fact' and column_name='ship_cost_manual_cents';
```
Expected: 1 row — `ship_cost_manual_cents | YES | integer`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260615130000_ship_cost_manual_override.sql
git commit -m "supabase: order_fact.ship_cost_manual_cents — manual ship-cost override storage"
```

---

## Task 2: Runner reads the manual override (closes the Plan 1 gap)

**Files:**
- Modify: `app/lib/ship-cost/runner.server.ts`
- Test: `app/lib/ship-cost/__tests__/runner.test.ts`

> **Dependency note:** This is the hard prerequisite that makes Task 5's override table do anything. Plan 1's runner hard-codes `manualOverrideCents: null`; this task wires it to the column from Task 1.

- [ ] **Step 1: Write the failing test**

Append to `app/lib/ship-cost/__tests__/runner.test.ts` (the `makeFakeSupabase` helper from Plan 1 Task 9 already exists in `./helpers`):

```ts
it("manual override wins over allocation and stamps source 'manual'", async () => {
  const sb = makeFakeSupabase({
    order_fact: [
      { id: "a", shop_id: "s", customer_country: "US", grams_sum: 100, item_count: 1, fulfillment_count: 1, ship_cost_manual_cents: 999 },
      { id: "b", shop_id: "s", customer_country: "US", grams_sum: 100, item_count: 1, fulfillment_count: 1, ship_cost_manual_cents: null },
    ],
    shipping_cost_period: [{ shop_id: "s", total_cents: 8000 }],
    shipping_invoice_line: [],
  });
  await runShipCostResolution(sb, "s", { shopCountry: "US" });
  const written = sb.updates("order_fact");
  const a = written.find((u) => u.id === "a")!;
  expect(a.ship_cost_cents).toBe(999);
  expect(a.ship_cost_source).toBe("manual");
  expect(a.ship_cost_confidence).toBe("high");
  // b has no override → still reconciled allocation
  expect(written.find((u) => u.id === "b")!.ship_cost_source).toBe("reconciled");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/ship-cost/__tests__/runner.test.ts -t "manual override wins"`
Expected: FAIL — order `a` resolves to `reconciled` because the runner ignores `ship_cost_manual_cents`.

- [ ] **Step 3: Wire the column into the runner**

In `app/lib/ship-cost/runner.server.ts`, add `ship_cost_manual_cents` to the `order_fact` select, and pass it into the signals. Change the select string:
```ts
  const { data: orders = [] } = await sb
    .from("order_fact")
    .select("id, customer_country, grams_sum, item_count, fulfillment_count, ship_cost_manual_cents")
    .eq("shop_id", shopId);
```
And in the per-order resolve call, replace the hard-coded `manualOverrideCents: null` with:
```ts
      manualOverrideCents: o.ship_cost_manual_cents ?? null,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/ship-cost/__tests__/runner.test.ts -t "manual override wins"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/ship-cost/runner.server.ts app/lib/ship-cost/__tests__/runner.test.ts
git commit -m "ship-cost/runner: read ship_cost_manual_cents into manualOverrideCents (closes Plan 1 gap)"
```

---

## Task 3: CSV invoice parser (pure)

**Files:**
- Create: `app/lib/ship-cost/csv.ts`
- Test: `app/lib/ship-cost/__tests__/csv.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { parseInvoiceCsv } from "../csv";

describe("parseInvoiceCsv", () => {
  it("parses order#, tracking#, and dollar cost into cents", () => {
    const { rows, errors } = parseInvoiceCsv(
      "order,tracking,cost\n#1001,1Z999,4.50\n#1002,1Z888,12.00\n",
    );
    expect(errors).toEqual([]);
    expect(rows).toEqual([
      { orderRef: "#1001", trackingNo: "1Z999", costCents: 450 },
      { orderRef: "#1002", trackingNo: "1Z888", costCents: 1200 },
    ]);
  });
  it("recognizes header aliases (order#, tracking#, amount)", () => {
    const { rows } = parseInvoiceCsv("order#,tracking#,amount\n#5,T5,3.00\n");
    expect(rows[0]).toEqual({ orderRef: "#5", trackingNo: "T5", costCents: 300 });
  });
  it("flags rows with an unparseable cost instead of dropping them", () => {
    const { rows, errors } = parseInvoiceCsv("order,cost\n#1,abc\n#2,5.00\n");
    expect(rows).toEqual([{ orderRef: "#2", trackingNo: null, costCents: 500 }]);
    expect(errors).toEqual([{ line: 2, reason: 'unparseable cost "abc"' }]);
  });
  it("errors when no cost column is present", () => {
    const { rows, errors } = parseInvoiceCsv("order,tracking\n#1,T1\n");
    expect(rows).toEqual([]);
    expect(errors).toEqual([{ line: 0, reason: "missing required cost column" }]);
  });
  it("requires at least one of order or tracking per row", () => {
    const { rows, errors } = parseInvoiceCsv("order,tracking,cost\n,,5.00\n");
    expect(rows).toEqual([]);
    expect(errors).toEqual([{ line: 2, reason: "row has neither order ref nor tracking number" }]);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run app/lib/ship-cost/__tests__/csv.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
export interface ParsedInvoiceRow {
  orderRef: string | null;
  trackingNo: string | null;
  costCents: number;
}

export interface ParseError {
  /** 1-based source line, or 0 for a header-level error. */
  line: number;
  reason: string;
}

export interface ParseResult {
  rows: ParsedInvoiceRow[];
  errors: ParseError[];
}

const ORDER_KEYS = ["order", "order#", "order_no", "order number", "order_number", "name"];
const TRACKING_KEYS = ["tracking", "tracking#", "tracking_no", "tracking number", "tracking_number"];
const COST_KEYS = ["cost", "amount", "charge", "total", "price"];

function splitCsvLine(line: string): string[] {
  // Minimal CSV: handles quoted fields with embedded commas; no escaped quotes.
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function findIndex(header: string[], keys: string[]): number {
  return header.findIndex((h) => keys.includes(h.toLowerCase()));
}

function parseCost(raw: string): number | null {
  const cleaned = raw.replace(/[$,\s]/g, "");
  if (cleaned === "" || !/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  return Math.round(parseFloat(cleaned) * 100);
}

export function parseInvoiceCsv(text: string): ParseResult {
  const rows: ParsedInvoiceRow[] = [];
  const errors: ParseError[] = [];
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) {
    return { rows, errors: [{ line: 0, reason: "empty file" }] };
  }
  const header = splitCsvLine(lines[0]);
  const orderIdx = findIndex(header, ORDER_KEYS);
  const trackingIdx = findIndex(header, TRACKING_KEYS);
  const costIdx = findIndex(header, COST_KEYS);
  if (costIdx === -1) {
    return { rows, errors: [{ line: 0, reason: "missing required cost column" }] };
  }
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    const orderRef = orderIdx >= 0 ? cells[orderIdx] || "" : "";
    const trackingNo = trackingIdx >= 0 ? cells[trackingIdx] || "" : "";
    if (!orderRef && !trackingNo) {
      errors.push({ line: i + 1, reason: "row has neither order ref nor tracking number" });
      continue;
    }
    const costCents = parseCost(cells[costIdx] ?? "");
    if (costCents === null) {
      errors.push({ line: i + 1, reason: `unparseable cost "${cells[costIdx] ?? ""}"` });
      continue;
    }
    rows.push({
      orderRef: orderRef || null,
      trackingNo: trackingNo || null,
      costCents,
    });
  }
  return { rows, errors };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run app/lib/ship-cost/__tests__/csv.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/ship-cost/csv.ts app/lib/ship-cost/__tests__/csv.test.ts
git commit -m "ship-cost/csv: parse carrier invoice CSV to cents, flag bad rows (never drop silently)"
```

---

## Task 4: Match invoice lines to orders (pure)

**Files:**
- Create: `app/lib/ship-cost/match.ts`
- Test: `app/lib/ship-cost/__tests__/match.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { matchInvoiceLines } from "../match";
import type { ParsedInvoiceRow } from "../csv";

const orders = [
  { id: "o1", orderNumber: "#1001", trackingNos: ["1Z999"] },
  { id: "o2", orderNumber: "#1002", trackingNos: ["1Z888", "1Z777"] },
];

describe("matchInvoiceLines", () => {
  it("matches by order number first", () => {
    const rows: ParsedInvoiceRow[] = [{ orderRef: "#1001", trackingNo: null, costCents: 450 }];
    const { matched, unmatched } = matchInvoiceLines(rows, orders);
    expect(matched).toEqual([{ matchedOrderId: "o1", orderRef: "#1001", trackingNo: null, costCents: 450 }]);
    expect(unmatched).toEqual([]);
  });
  it("falls back to tracking number when order ref misses", () => {
    const rows: ParsedInvoiceRow[] = [{ orderRef: "#9999", trackingNo: "1Z777", costCents: 1200 }];
    const { matched } = matchInvoiceLines(rows, orders);
    expect(matched[0].matchedOrderId).toBe("o2");
  });
  it("normalizes order ref (case + leading #/spaces)", () => {
    const rows: ParsedInvoiceRow[] = [{ orderRef: " 1001 ", trackingNo: null, costCents: 100 }];
    expect(matchInvoiceLines(rows, orders).matched[0].matchedOrderId).toBe("o1");
  });
  it("surfaces unmatched lines instead of dropping them", () => {
    const rows: ParsedInvoiceRow[] = [{ orderRef: "#404", trackingNo: "NOPE", costCents: 700 }];
    const { matched, unmatched } = matchInvoiceLines(rows, orders);
    expect(matched).toEqual([]);
    expect(unmatched).toEqual([{ orderRef: "#404", trackingNo: "NOPE", costCents: 700, matchedOrderId: null }]);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run app/lib/ship-cost/__tests__/match.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
import type { ParsedInvoiceRow } from "./csv";

export interface MatchOrder {
  id: string;
  orderNumber: string;
  trackingNos: string[];
}

export interface InvoiceLineRow {
  orderRef: string | null;
  trackingNo: string | null;
  costCents: number;
  matchedOrderId: string | null;
}

export interface MatchResult {
  matched: InvoiceLineRow[];
  unmatched: InvoiceLineRow[];
}

/** Strip a leading '#', trim, lowercase — so "#1001", " 1001 ", "1001" all match. */
function normOrder(ref: string): string {
  return ref.replace(/^#/, "").trim().toLowerCase();
}

export function matchInvoiceLines(rows: ParsedInvoiceRow[], orders: MatchOrder[]): MatchResult {
  const byOrder = new Map<string, string>();
  const byTracking = new Map<string, string>();
  for (const o of orders) {
    byOrder.set(normOrder(o.orderNumber), o.id);
    for (const t of o.trackingNos) byTracking.set(t.trim().toLowerCase(), o.id);
  }
  const matched: InvoiceLineRow[] = [];
  const unmatched: InvoiceLineRow[] = [];
  for (const r of rows) {
    let id: string | undefined;
    if (r.orderRef) id = byOrder.get(normOrder(r.orderRef));
    if (!id && r.trackingNo) id = byTracking.get(r.trackingNo.trim().toLowerCase());
    const line: InvoiceLineRow = {
      orderRef: r.orderRef,
      trackingNo: r.trackingNo,
      costCents: r.costCents,
      matchedOrderId: id ?? null,
    };
    if (id) matched.push(line);
    else unmatched.push(line);
  }
  return { matched, unmatched };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run app/lib/ship-cost/__tests__/match.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/ship-cost/match.ts app/lib/ship-cost/__tests__/match.test.ts
git commit -m "ship-cost/match: match invoice lines by order number then tracking; surface unmatched"
```

---

## Task 5: Missing-weight percentage (pure)

**Files:**
- Create: `app/lib/ship-cost/missing-weight.ts`
- Test: `app/lib/ship-cost/__tests__/missing-weight.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { missingWeightPct } from "../missing-weight";

describe("missingWeightPct", () => {
  it("returns the rounded percentage of orders missing weight", () => {
    expect(missingWeightPct([{ gramsSum: 100 }, { gramsSum: null }, { gramsSum: 0 }, { gramsSum: 50 }])).toBe(50);
  });
  it("treats null and 0 grams as missing", () => {
    expect(missingWeightPct([{ gramsSum: 0 }, { gramsSum: null }])).toBe(100);
  });
  it("returns 0 for an empty set (no orders, nothing degraded)", () => {
    expect(missingWeightPct([])).toBe(0);
  });
  it("returns 0 when all orders have weight", () => {
    expect(missingWeightPct([{ gramsSum: 10 }, { gramsSum: 20 }])).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run app/lib/ship-cost/__tests__/missing-weight.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
export interface WeightProbe {
  gramsSum: number | null;
}

/** Percent (0..100, rounded) of orders with no usable weight. 0 when no orders. */
export function missingWeightPct(orders: WeightProbe[]): number {
  if (orders.length === 0) return 0;
  const missing = orders.filter((o) => o.gramsSum == null || o.gramsSum <= 0).length;
  return Math.round((missing / orders.length) * 100);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run app/lib/ship-cost/__tests__/missing-weight.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/ship-cost/missing-weight.ts app/lib/ship-cost/__tests__/missing-weight.test.ts
git commit -m "ship-cost/missing-weight: percent of orders missing weight (data-quality nudge)"
```

---

## Task 6: Input server wrappers (write + re-resolve)

**Files:**
- Create: `app/lib/ship-cost/inputs.server.ts`
- Test: `app/lib/ship-cost/__tests__/inputs.test.ts`

- [ ] **Step 1: Write the failing tests**

The `makeFakeSupabase` helper from Plan 1 Task 9 (`./helpers`) is reused; extend it if it lacks an `inserts(table)` accessor (add the same way `updates(table)` was added). The runner is mocked so we assert the wrapper writes rows and triggers re-resolution.

```ts
import { vi } from "vitest";
import { saveTypedPeriodTotal, ingestInvoiceCsv, setManualOverride } from "../inputs.server";
import { makeFakeSupabase } from "./helpers";

vi.mock("../runner.server", () => ({ runShipCostResolution: vi.fn().mockResolvedValue(undefined) }));
import { runShipCostResolution } from "../runner.server";

describe("saveTypedPeriodTotal", () => {
  it("inserts a typed period row and re-resolves", async () => {
    const sb = makeFakeSupabase({ shipping_cost_period: [], order_fact: [], shipping_invoice_line: [] });
    await saveTypedPeriodTotal(sb, "s", { totalCents: 50000, carrier: "UPS", periodStart: "2026-05-01", periodEnd: "2026-05-31", shopCountry: "US" });
    const row = sb.inserts("shipping_cost_period")[0];
    expect(row).toMatchObject({ shop_id: "s", total_cents: 50000, carrier: "UPS", source: "typed", period_start: "2026-05-01", period_end: "2026-05-31" });
    expect(runShipCostResolution).toHaveBeenCalledWith(sb, "s", { shopCountry: "US" });
  });
});

describe("ingestInvoiceCsv", () => {
  it("creates an upload period, writes lines, returns unmatched, and re-resolves", async () => {
    const sb = makeFakeSupabase({
      shipping_cost_period: [],
      shipping_invoice_line: [],
      order_fact: [{ id: "o1", shop_id: "s", order_number: "#1001" }],
    });
    const csv = "order,tracking,cost\n#1001,1Z1,4.50\n#404,NOPE,7.00\n";
    const result = await ingestInvoiceCsv(sb, "s", { csvText: csv, carrier: "UPS", periodStart: "2026-05-01", periodEnd: "2026-05-31", shopCountry: "US" });
    expect(sb.inserts("shipping_cost_period")[0]).toMatchObject({ source: "upload", total_cents: 1150 });
    const lines = sb.inserts("shipping_invoice_line");
    expect(lines).toHaveLength(2);
    expect(lines.find((l) => l.order_ref === "#1001")!.matched_order_id).toBe("o1");
    expect(result.matchedCount).toBe(1);
    expect(result.unmatched).toEqual([{ orderRef: "#404", trackingNo: "NOPE", costCents: 700, matchedOrderId: null }]);
    expect(result.parseErrors).toEqual([]);
    expect(runShipCostResolution).toHaveBeenCalledWith(sb, "s", { shopCountry: "US" });
  });
});

describe("setManualOverride", () => {
  it("writes ship_cost_manual_cents and re-resolves", async () => {
    const sb = makeFakeSupabase({ order_fact: [{ id: "o1", shop_id: "s" }], shipping_cost_period: [], shipping_invoice_line: [] });
    await setManualOverride(sb, "s", { orderId: "o1", cents: 333, shopCountry: "US" });
    expect(sb.updates("order_fact")[0]).toMatchObject({ id: "o1", ship_cost_manual_cents: 333 });
    expect(runShipCostResolution).toHaveBeenCalledWith(sb, "s", { shopCountry: "US" });
  });
  it("clears the override when cents is null", async () => {
    const sb = makeFakeSupabase({ order_fact: [{ id: "o1", shop_id: "s" }], shipping_cost_period: [], shipping_invoice_line: [] });
    await setManualOverride(sb, "s", { orderId: "o1", cents: null, shopCountry: "US" });
    expect(sb.updates("order_fact")[0].ship_cost_manual_cents).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run app/lib/ship-cost/__tests__/inputs.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { parseInvoiceCsv } from "./csv";
import { matchInvoiceLines, type MatchOrder, type InvoiceLineRow } from "./match";
import { runShipCostResolution } from "./runner.server";

interface ReResolveOpts {
  shopCountry: string | null;
}

export interface TypedPeriodInput extends ReResolveOpts {
  totalCents: number;
  carrier: string | null;
  periodStart: string;
  periodEnd: string;
}

export async function saveTypedPeriodTotal(
  sb: SupabaseClient,
  shopId: string,
  input: TypedPeriodInput,
): Promise<void> {
  await sb.from("shipping_cost_period").insert({
    shop_id: shopId,
    period_start: input.periodStart,
    period_end: input.periodEnd,
    carrier: input.carrier,
    total_cents: input.totalCents,
    source: "typed",
  });
  await runShipCostResolution(sb, shopId, { shopCountry: input.shopCountry });
}

export interface InvoiceCsvInput extends ReResolveOpts {
  csvText: string;
  carrier: string | null;
  periodStart: string;
  periodEnd: string;
}

export interface InvoiceCsvResult {
  matchedCount: number;
  unmatched: InvoiceLineRow[];
  parseErrors: { line: number; reason: string }[];
}

export async function ingestInvoiceCsv(
  sb: SupabaseClient,
  shopId: string,
  input: InvoiceCsvInput,
): Promise<InvoiceCsvResult> {
  const { rows, errors } = parseInvoiceCsv(input.csvText);

  // Load the shop's orders (id + order_number) for matching. Tracking match is
  // best-effort: include tracking_no from fulfillment_fact when present.
  const { data: orders = [] } = await sb
    .from("order_fact")
    .select("id, order_number")
    .eq("shop_id", shopId);
  const { data: fulfills = [] } = await sb
    .from("fulfillment_fact")
    .select("order_id, tracking_no")
    .eq("shop_id", shopId);
  const trackingByOrder = new Map<string, string[]>();
  for (const f of fulfills) {
    if (!f.order_id || !f.tracking_no) continue;
    const list = trackingByOrder.get(f.order_id) ?? [];
    list.push(String(f.tracking_no));
    trackingByOrder.set(f.order_id, list);
  }
  const matchOrders: MatchOrder[] = orders.map((o) => ({
    id: o.id,
    orderNumber: String(o.order_number ?? ""),
    trackingNos: trackingByOrder.get(o.id) ?? [],
  }));

  const { matched, unmatched } = matchInvoiceLines(rows, matchOrders);
  const totalCents = rows.reduce((s, r) => s + r.costCents, 0);

  const { data: period } = await sb
    .from("shipping_cost_period")
    .insert({
      shop_id: shopId,
      period_start: input.periodStart,
      period_end: input.periodEnd,
      carrier: input.carrier,
      total_cents: totalCents,
      source: "upload",
    })
    .select("id")
    .single();
  const periodId = period?.id ?? null;

  const allLines = [...matched, ...unmatched];
  if (allLines.length > 0) {
    await sb.from("shipping_invoice_line").insert(
      allLines.map((l) => ({
        shop_id: shopId,
        period_id: periodId,
        order_ref: l.orderRef,
        tracking_no: l.trackingNo,
        cost_cents: l.costCents,
        matched_order_id: l.matchedOrderId,
      })),
    );
  }

  await runShipCostResolution(sb, shopId, { shopCountry: input.shopCountry });
  return { matchedCount: matched.length, unmatched, parseErrors: errors };
}

export interface ManualOverrideInput extends ReResolveOpts {
  orderId: string;
  /** null clears the override. */
  cents: number | null;
}

export async function setManualOverride(
  sb: SupabaseClient,
  shopId: string,
  input: ManualOverrideInput,
): Promise<void> {
  await sb
    .from("order_fact")
    .update({ ship_cost_manual_cents: input.cents })
    .eq("id", input.orderId)
    .eq("shop_id", shopId);
  await runShipCostResolution(sb, shopId, { shopCountry: input.shopCountry });
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run app/lib/ship-cost/__tests__/inputs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/ship-cost/inputs.server.ts app/lib/ship-cost/__tests__/inputs.test.ts
git commit -m "ship-cost/inputs.server: typed total, CSV ingest+match, manual override — each re-resolves"
```

---

## Task 7: Settings loader/action — ship-cost intents

**Files:**
- Modify: `app/routes/app.settings.tsx`
- Test: `app/routes/__tests__/app.settings.shipcost.test.ts`

> The route's existing loader pulls guardrails/integrations/consent via `calderynClient`. We extend it to also compute the missing-weight % and the shop mode via direct Supabase reads (matching the `sync_now` precedent that already uses `getSupabase()`/`resolveShopId()` in this file). Ship-mode is stored on a single `shop_settings(shop_id, ship_cost_mode)` row — added in the same migration as Task 1 if not present.

- [ ] **Step 1: Extend the migration with `shop_settings.ship_cost_mode`**

Append to `supabase/migrations/20260615130000_ship_cost_manual_override.sql`:
```sql
-- Shop-level ship-cost mode. One row per shop; 'auto' is the recommended default.
create table if not exists public.shop_settings (
  shop_id        uuid primary key references shops(id) on delete cascade,
  ship_cost_mode text not null default 'auto'
    check (ship_cost_mode in ('auto','force_measured','force_reconciled')),
  updated_at     timestamptz not null default now()
);
-- App reaches this only via the service-role key (BYPASSRLS); deny-all to other
-- roles, mirroring integration_credentials_rls.
alter table public.shop_settings enable row level security;
revoke all on table public.shop_settings from anon, authenticated;
```
Re-apply the migration to the dev branch (MCP `apply_migration`) and confirm:
```sql
select column_name from information_schema.columns where table_name='shop_settings';
```
Expected rows: `shop_id`, `ship_cost_mode`, `updated_at`.

- [ ] **Step 2: Write the failing test (a pure FormData-validation helper)**

Because the route action calls `authenticate.admin`, test the boundary-validation logic as an exported pure helper rather than the whole action. Create `app/routes/__tests__/app.settings.shipcost.test.ts`:

```ts
import { parsePeriodTotalForm, parseManualOverrideForm } from "../app.settings";

const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

describe("parsePeriodTotalForm", () => {
  it("parses dollars to cents + carrier + dates", () => {
    const r = parsePeriodTotalForm(fd({ amount: "500.00", carrier: "UPS", period_start: "2026-05-01", period_end: "2026-05-31" }));
    expect(r).toEqual({ ok: true, value: { totalCents: 50000, carrier: "UPS", periodStart: "2026-05-01", periodEnd: "2026-05-31" } });
  });
  it("rejects a non-positive amount", () => {
    expect(parsePeriodTotalForm(fd({ amount: "0", period_start: "2026-05-01", period_end: "2026-05-31" })).ok).toBe(false);
  });
  it("rejects missing/blank dates", () => {
    expect(parsePeriodTotalForm(fd({ amount: "5", period_start: "", period_end: "2026-05-31" })).ok).toBe(false);
  });
});

describe("parseManualOverrideForm", () => {
  it("parses an order id + dollar override to cents", () => {
    expect(parseManualOverrideForm(fd({ order_id: "o1", amount: "3.33" }))).toEqual({ ok: true, value: { orderId: "o1", cents: 333 } });
  });
  it("treats a blank amount as a clear (null cents)", () => {
    expect(parseManualOverrideForm(fd({ order_id: "o1", amount: "" }))).toEqual({ ok: true, value: { orderId: "o1", cents: null } });
  });
  it("rejects a missing order id", () => {
    expect(parseManualOverrideForm(fd({ amount: "1.00" })).ok).toBe(false);
  });
});
```

- [ ] **Step 3: Run to verify fail**

Run: `npx vitest run app/routes/__tests__/app.settings.shipcost.test.ts`
Expected: FAIL (helpers not exported).

- [ ] **Step 4: Add the exported validation helpers to `app.settings.tsx`**

Add near the top of `app/routes/app.settings.tsx` (after imports, before `loader`):

```ts
export type ParseOk<T> = { ok: true; value: T };
export type ParseErr = { ok: false; message: string };

export interface PeriodTotalValue {
  totalCents: number;
  carrier: string | null;
  periodStart: string;
  periodEnd: string;
}

export function parsePeriodTotalForm(
  fd: FormData,
): ParseOk<PeriodTotalValue> | ParseErr {
  const amount = Number(String(fd.get("amount") ?? "").trim());
  const carrier = String(fd.get("carrier") ?? "").trim() || null;
  const periodStart = String(fd.get("period_start") ?? "").trim();
  const periodEnd = String(fd.get("period_end") ?? "").trim();
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, message: "Enter a shipping total greater than $0." };
  }
  if (!periodStart || !periodEnd) {
    return { ok: false, message: "Enter both a start and end date for the period." };
  }
  return {
    ok: true,
    value: { totalCents: Math.round(amount * 100), carrier, periodStart, periodEnd },
  };
}

export interface ManualOverrideValue {
  orderId: string;
  /** null clears the override. */
  cents: number | null;
}

export function parseManualOverrideForm(
  fd: FormData,
): ParseOk<ManualOverrideValue> | ParseErr {
  const orderId = String(fd.get("order_id") ?? "").trim();
  const raw = String(fd.get("amount") ?? "").trim();
  if (!orderId) return { ok: false, message: "Missing order." };
  if (raw === "") return { ok: true, value: { orderId, cents: null } };
  const amount = Number(raw);
  if (!Number.isFinite(amount) || amount < 0) {
    return { ok: false, message: "Override must be $0 or more." };
  }
  return { ok: true, value: { orderId, cents: Math.round(amount * 100) } };
}
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run app/routes/__tests__/app.settings.shipcost.test.ts`
Expected: PASS.

- [ ] **Step 6: Wire the action intents**

In the `action` of `app/routes/app.settings.tsx`, add these branches before the final `INVALID_INTENT` fallback. Add the imports at the top: `import { getShopCountry } from "~/lib/ship-cost/shop-country.server";` (created in Step 7) and `import { saveTypedPeriodTotal, ingestInvoiceCsv, setManualOverride } from "~/lib/ship-cost/inputs.server";`. Also import `unstable_parseMultipartFormData, unstable_createMemoryUploadHandler` from `@remix-run/node` at the top.

```ts
    if (intent === "set_ship_mode") {
      const mode = String(formData.get("ship_cost_mode") || "");
      if (!["auto", "force_measured", "force_reconciled"].includes(mode)) {
        return json<ActionPayload>(
          { ok: false, error: { code: "INVALID_MODE", message: "Unknown mode." }, toast: { message: "Unknown mode", isError: true } },
          { status: 400 },
        );
      }
      const sb = getSupabase();
      const shopId = await resolveShopId(session.shop);
      await sb.from("shop_settings").upsert({ shop_id: shopId, ship_cost_mode: mode, updated_at: new Date().toISOString() });
      return json<ActionPayload>({ ok: true, toast: { message: "Shipping cost mode saved" } });
    }

    if (intent === "add_period_total") {
      const parsed = parsePeriodTotalForm(formData);
      if (!parsed.ok) {
        return json<ActionPayload>(
          { ok: false, error: { code: "INVALID_INPUT", message: parsed.message }, toast: { message: parsed.message, isError: true } },
          { status: 422 },
        );
      }
      const sb = getSupabase();
      const shopId = await resolveShopId(session.shop);
      await saveTypedPeriodTotal(sb, shopId, { ...parsed.value, shopCountry: await getShopCountry(sb, shopId) });
      return json<ActionPayload>({ ok: true, toast: { message: "Shipping total saved — margins updated" } });
    }

    if (intent === "set_manual_override") {
      const parsed = parseManualOverrideForm(formData);
      if (!parsed.ok) {
        return json<ActionPayload>(
          { ok: false, error: { code: "INVALID_INPUT", message: parsed.message }, toast: { message: parsed.message, isError: true } },
          { status: 422 },
        );
      }
      const sb = getSupabase();
      const shopId = await resolveShopId(session.shop);
      await setManualOverride(sb, shopId, { ...parsed.value, shopCountry: await getShopCountry(sb, shopId) });
      return json<ActionPayload>({ ok: true, toast: { message: parsed.value.cents == null ? "Override cleared" : "Override saved" } });
    }
```

The CSV upload needs the multipart-parsed body, so it is handled at the very top of `action` BEFORE `request.formData()` consumes the stream. Add this as the first thing inside `action`, replacing the existing `const formData = await request.formData();` line with a content-type branch:

```ts
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    const uploadHandler = unstable_createMemoryUploadHandler({ maxPartSize: 5_000_000 });
    const mp = await unstable_parseMultipartFormData(request, uploadHandler);
    if (String(mp.get("intent") || "") === "upload_invoice_csv") {
      const file = mp.get("file");
      const carrier = String(mp.get("carrier") || "").trim() || null;
      const periodStart = String(mp.get("period_start") || "").trim();
      const periodEnd = String(mp.get("period_end") || "").trim();
      if (!(file instanceof File) || file.size === 0) {
        return json<ActionPayload>(
          { ok: false, error: { code: "NO_FILE", message: "Choose a CSV file to upload." }, toast: { message: "Choose a CSV file to upload.", isError: true } },
          { status: 422 },
        );
      }
      if (!periodStart || !periodEnd) {
        return json<ActionPayload>(
          { ok: false, error: { code: "INVALID_INPUT", message: "Enter the period dates the invoice covers." }, toast: { message: "Enter the period dates.", isError: true } },
          { status: 422 },
        );
      }
      const csvText = await file.text();
      const sb = getSupabase();
      const shopId = await resolveShopId(session.shop);
      const result = await ingestInvoiceCsv(sb, shopId, { csvText, carrier, periodStart, periodEnd, shopCountry: await getShopCountry(sb, shopId) });
      const unmatchedRefs = result.unmatched.map((u) => u.orderRef ?? u.trackingNo ?? "?");
      return json<ActionPayload>({
        ok: true,
        uploadResult: {
          matched: result.matchedCount,
          unmatchedRefs,
          parseErrors: result.parseErrors.map((e) => `line ${e.line}: ${e.reason}`),
        },
        toast: {
          message:
            result.unmatched.length === 0 && result.parseErrors.length === 0
              ? `Invoice uploaded — ${result.matchedCount} orders matched`
              : `Uploaded — ${result.matchedCount} matched, ${result.unmatched.length} unmatched`,
          isError: false,
        },
      });
    }
  }
  const formData = await request.formData();
```

Extend the `ActionPayload` type with the optional upload result:
```ts
  uploadResult?: { matched: number; unmatchedRefs: string[]; parseErrors: string[] };
```

- [ ] **Step 7: Add the shop-country helper + loader fields**

Create `app/lib/ship-cost/shop-country.server.ts`:
```ts
import type { SupabaseClient } from "@supabase/supabase-js";

/** Shop's home country (ISO code) used as the origin for zone classification.
 * Falls back to null, which the zone classifier treats as 'domestic'. */
export async function getShopCountry(sb: SupabaseClient, shopId: string): Promise<string | null> {
  const { data } = await sb.from("shops").select("country_code").eq("id", shopId).maybeSingle();
  return (data?.country_code as string | null) ?? null;
}
```
> Implementation note: confirm the `shops` column name during execution (`select column_name from information_schema.columns where table_name='shops'`); if it is not `country_code`, adjust this one select. The rest of the plan does not depend on the exact name.

In the `loader`, add ship-cost loader data. After the existing `Promise.all`, before `return json`, compute (the loader already has `session`):
```ts
    const sb = getSupabase();
    const shopId = await resolveShopId(session.shop);
    const [{ data: settingsRow }, { data: orderRows }] = await Promise.all([
      sb.from("shop_settings").select("ship_cost_mode").eq("shop_id", shopId).maybeSingle(),
      sb.from("order_fact").select("grams_sum").eq("shop_id", shopId),
    ]);
    const shipMode = (settingsRow?.ship_cost_mode as string | null) ?? "auto";
    const missingWeight = missingWeightPct((orderRows ?? []).map((o) => ({ gramsSum: o.grams_sum ?? null })));
```
Add to `LoaderPayload`: `shipMode: string; missingWeightPct: number;` and include `shipMode, missingWeightPct: missingWeight` in the success `json(...)`. In the catch branch, default them: `shipMode: "auto", missingWeightPct: 0`. Add the import `import { missingWeightPct } from "~/lib/ship-cost/missing-weight";`.

- [ ] **Step 8: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 9: Commit**

```bash
git add app/routes/app.settings.tsx app/routes/__tests__/app.settings.shipcost.test.ts app/lib/ship-cost/shop-country.server.ts supabase/migrations/20260615130000_ship_cost_manual_override.sql
git commit -m "routes/app.settings: ship-cost loader + action intents (mode, total, csv upload, override)"
```

---

## Task 8: Settings UI — "Shipping cost" section

**Files:**
- Modify: `app/routes/app.settings.tsx`

> This is React/Polaris UI; verified by `typecheck` + `build` (no Vitest DOM test — matches the repo, which has no component tests for these routes). The section reads `shipMode` / `missingWeightPct` from the loader and `actionData?.uploadResult` for the post-upload report.

- [ ] **Step 1: Add the section component**

Append this component to `app/routes/app.settings.tsx`:

```tsx
function ShippingCostSection({
  shipMode,
  missingWeightPct,
}: {
  shipMode: string;
  missingWeightPct: number;
}) {
  const actionData = useActionData<typeof action>();
  const [mode, setMode] = useState(shipMode);
  const upload = actionData?.uploadResult;
  return (
    <BlockStack gap="400">
      <Card>
        <BlockStack gap="300">
          <Text as="h3" variant="headingSm">
            Mode
          </Text>
          <Form method="post">
            <input type="hidden" name="intent" value="set_ship_mode" />
            <FormLayout>
              <Select
                label="How Calderyn estimates each order's shipping cost"
                name="ship_cost_mode"
                value={mode}
                onChange={setMode}
                options={[
                  { label: "Automatic (recommended)", value: "auto" },
                  { label: "Always use measured (invoice) costs", value: "force_measured" },
                  { label: "Always allocate from my period total", value: "force_reconciled" },
                ]}
                helpText="Automatic picks the most trustworthy source per order: an invoice line, else an allocation of your period total."
              />
              <InlineStack align="end">
                <Button submit variant="primary">
                  Save mode
                </Button>
              </InlineStack>
            </FormLayout>
          </Form>
        </BlockStack>
      </Card>

      {missingWeightPct > 0 && (
        <Banner tone="warning" title={`${missingWeightPct}% of your orders are missing weight`}>
          <p>
            Shipping estimates are degraded for those orders. Add product weights in
            Shopify to improve per-order accuracy.
          </p>
        </Banner>
      )}

      <Card>
        <BlockStack gap="300">
          <Text as="h3" variant="headingSm">
            Period total
          </Text>
          <Text as="p" tone="subdued" variant="bodySm">
            Enter what you actually paid your carrier for a period. Calderyn allocates
            it across that period&rsquo;s orders by weight and destination.
          </Text>
          <Form method="post">
            <input type="hidden" name="intent" value="add_period_total" />
            <FormLayout>
              <FormLayout.Group>
                <TextField label="Total paid (USD)" name="amount" type="number" autoComplete="off" />
                <TextField label="Carrier (optional)" name="carrier" autoComplete="off" />
              </FormLayout.Group>
              <FormLayout.Group>
                <TextField label="Period start" name="period_start" type="date" autoComplete="off" />
                <TextField label="Period end" name="period_end" type="date" autoComplete="off" />
              </FormLayout.Group>
              <InlineStack align="end">
                <Button submit variant="primary">
                  Save total
                </Button>
              </InlineStack>
            </FormLayout>
          </Form>
        </BlockStack>
      </Card>

      <Card>
        <BlockStack gap="300">
          <Text as="h3" variant="headingSm">
            Upload a carrier invoice (CSV)
          </Text>
          <Text as="p" tone="subdued" variant="bodySm">
            We match each line to an order by order number, then by tracking number.
            Unmatched lines are listed below so nothing is silently dropped.
          </Text>
          <Form method="post" encType="multipart/form-data">
            <input type="hidden" name="intent" value="upload_invoice_csv" />
            <FormLayout>
              <FormLayout.Group>
                <TextField label="Period start" name="period_start" type="date" autoComplete="off" />
                <TextField label="Period end" name="period_end" type="date" autoComplete="off" />
              </FormLayout.Group>
              <TextField label="Carrier (optional)" name="carrier" autoComplete="off" />
              <input type="file" name="file" accept=".csv,text/csv" />
              <InlineStack align="end">
                <Button submit variant="primary">
                  Upload invoice
                </Button>
              </InlineStack>
            </FormLayout>
          </Form>
          {upload && (
            <BlockStack gap="200">
              <Banner tone={upload.unmatchedRefs.length || upload.parseErrors.length ? "warning" : "success"}>
                <p>{upload.matched} lines matched to orders.</p>
                {upload.unmatchedRefs.length > 0 && (
                  <p>
                    {upload.unmatchedRefs.length} unmatched (review):{" "}
                    {upload.unmatchedRefs.join(", ")}
                  </p>
                )}
                {upload.parseErrors.length > 0 && (
                  <p>Skipped rows: {upload.parseErrors.join("; ")}</p>
                )}
              </Banner>
            </BlockStack>
          )}
        </BlockStack>
      </Card>

      <Card>
        <BlockStack gap="200">
          <Text as="h3" variant="headingSm">
            Per-order correction
          </Text>
          <Text as="p" tone="subdued" variant="bodySm">
            Override a single order&rsquo;s shipping cost. Enter the order ID and an
            amount, or leave the amount blank to clear an override.
          </Text>
          <Form method="post">
            <input type="hidden" name="intent" value="set_manual_override" />
            <FormLayout>
              <FormLayout.Group>
                <TextField label="Order ID" name="order_id" autoComplete="off" />
                <TextField label="Shipping cost (USD)" name="amount" type="number" autoComplete="off" helpText="Blank clears the override." />
              </FormLayout.Group>
              <InlineStack align="end">
                <Button submit>Save override</Button>
              </InlineStack>
            </FormLayout>
          </Form>
        </BlockStack>
      </Card>
    </BlockStack>
  );
}
```

> Note: the per-order correction uses a simple Order-ID + amount form rather than a full `IndexTable` of every order — keeps the surface bounded (a shop can have thousands of orders) and matches the master design's "per-order correction → source = manual" requirement without an unbounded render. The override propagates through `setManualOverride` → runner → `source='manual'`.

- [ ] **Step 2: Render the section + read the new loader fields**

In the `Settings()` component, destructure the new loader fields:
```ts
  const { guardrails, integrations, consent, error, shipMode, missingWeightPct } =
    useLoaderData<typeof loader>();
```
Add this `Layout.AnnotatedSection` inside `<Layout>`, immediately before the `id="account-data"` section:
```tsx
          <Layout.AnnotatedSection
            id="shipping-cost"
            title="Shipping cost"
            description="Tell Calderyn what you pay to ship, so margin reflects true cost."
          >
            <ShippingCostSection shipMode={shipMode} missingWeightPct={missingWeightPct} />
          </Layout.AnnotatedSection>
```
`Select` is already imported? It is NOT in this file's Polaris import — add `Select` to the `@shopify/polaris` import list at the top.

- [ ] **Step 3: Typecheck + build**

Run: `npm run typecheck`
Expected: exit 0.
Run: `npm run build`
Expected: exit 0 (Remix + Vite build completes).

- [ ] **Step 4: Commit**

```bash
git add app/routes/app.settings.tsx
git commit -m "routes/app.settings: Shipping cost section — mode, period total, CSV upload, override, weight nudge"
```

---

## Task 9 (OPTIONAL): Shopify label-event parser

> **OPTIONAL — defer if time-constrained.** Implements the master design's
> "Events-stream parse, never load-bearing": parse `shipping_label_created` order
> timeline messages to an `eventParsedCents`, accept ONLY when the parsed sum
> reconciles under the period total, and flag malformed messages for review —
> never write `$0`. The pure parser stands alone; wiring `eventParsedCents` into
> the runner is a follow-on and is intentionally NOT included here (the resolver
> already supports the field; populating it from events is the optional bonus).

**Files:**
- Create: `app/lib/ship-cost/event-parse.ts`
- Test: `app/lib/ship-cost/__tests__/event-parse.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { parseLabelEvents } from "../event-parse";

describe("parseLabelEvents", () => {
  const msgs = [
    { orderId: "o1", message: "A $5.75 shipping label was created" },
    { orderId: "o2", message: "A $4.25 label was purchased" },
  ];
  it("parses dollar amounts to cents per order when sum reconciles under the total", () => {
    const { eventCentsByOrder, flagged, accepted } = parseLabelEvents(msgs, 2000);
    expect(accepted).toBe(true);
    expect(eventCentsByOrder.get("o1")).toBe(575);
    expect(eventCentsByOrder.get("o2")).toBe(425);
    expect(flagged).toEqual([]);
  });
  it("rejects (accepted=false) when the parsed sum exceeds the period total", () => {
    const { accepted, eventCentsByOrder } = parseLabelEvents(msgs, 900);
    expect(accepted).toBe(false);
    expect(eventCentsByOrder.size).toBe(0);
  });
  it("flags a malformed message for review and never writes $0", () => {
    const { eventCentsByOrder, flagged } = parseLabelEvents(
      [{ orderId: "o3", message: "label created (amount unavailable)" }],
      5000,
    );
    expect(eventCentsByOrder.has("o3")).toBe(false);
    expect(flagged).toEqual([{ orderId: "o3", message: "label created (amount unavailable)" }]);
  });
  it("accepts when there is no period total (null) — caller decides downstream gating", () => {
    const { accepted, eventCentsByOrder } = parseLabelEvents(msgs, null);
    expect(accepted).toBe(true);
    expect(eventCentsByOrder.get("o1")).toBe(575);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run app/lib/ship-cost/__tests__/event-parse.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
export interface LabelEvent {
  orderId: string;
  message: string;
}

export interface LabelParseResult {
  /** Per-order parsed label cost in cents. Empty when not accepted. */
  eventCentsByOrder: Map<string, number>;
  /** Messages we could not extract an amount from — surfaced for review, never $0. */
  flagged: LabelEvent[];
  /** False when the parsed sum exceeds the known period total (reconciliation guard). */
  accepted: boolean;
}

const AMOUNT_RE = /\$\s*(\d+(?:\.\d{1,2})?)/;

export function parseLabelEvents(
  events: LabelEvent[],
  periodTotalCents: number | null,
): LabelParseResult {
  const parsed = new Map<string, number>();
  const flagged: LabelEvent[] = [];
  for (const e of events) {
    const m = AMOUNT_RE.exec(e.message);
    if (!m) {
      flagged.push(e);
      continue;
    }
    parsed.set(e.orderId, Math.round(parseFloat(m[1]) * 100));
  }
  const sum = [...parsed.values()].reduce((s, v) => s + v, 0);
  const accepted = periodTotalCents == null || sum <= periodTotalCents;
  return {
    eventCentsByOrder: accepted ? parsed : new Map(),
    flagged,
    accepted,
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run app/lib/ship-cost/__tests__/event-parse.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/ship-cost/event-parse.ts app/lib/ship-cost/__tests__/event-parse.test.ts
git commit -m "ship-cost/event-parse: parse label events, reconcile-gate, flag malformed (never $0)"
```

---

## Task 10: Provenance badge on the SKU surface

**Files:**
- Create: `app/lib/ship-cost/provenance.ts`
- Test: `app/lib/ship-cost/__tests__/provenance.test.ts`
- Modify: `app/lib/types.ts` (add provenance fields to `SKU`)
- Modify: `app/lib/calderyn.server.ts` (`rowToSku` maps the fields)
- Modify: `app/routes/app.skus.tsx` (render the badge)

- [ ] **Step 1: Write the failing test for the label/tone helper**

```ts
import { shipCostBadge } from "../provenance";

describe("shipCostBadge", () => {
  it("maps source to a merchant-facing label + tone", () => {
    expect(shipCostBadge("actual_invoice")).toEqual({ label: "Actual", tone: "success" });
    expect(shipCostBadge("actual_event")).toEqual({ label: "Actual", tone: "success" });
    expect(shipCostBadge("reconciled")).toEqual({ label: "Reconciled", tone: "info" });
    expect(shipCostBadge("manual")).toEqual({ label: "Manual", tone: "info" });
    expect(shipCostBadge("modeled")).toEqual({ label: "Modeled", tone: "attention" });
    expect(shipCostBadge("fallback")).toEqual({ label: "Estimate", tone: "warning" });
  });
  it("returns null for an absent source", () => {
    expect(shipCostBadge(null)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run app/lib/ship-cost/__tests__/provenance.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the helper**

Create `app/lib/ship-cost/provenance.ts`:
```ts
import type { ShipCostSource } from "./types";

export type BadgeTone = "success" | "info" | "attention" | "warning";

export interface ShipCostBadge {
  label: string;
  tone: BadgeTone;
}

/** Merchant-facing label + Polaris Badge tone for a resolved ship-cost source.
 * null when the order/SKU has no resolved source yet. */
export function shipCostBadge(source: ShipCostSource | null): ShipCostBadge | null {
  switch (source) {
    case "actual_invoice":
    case "actual_event":
      return { label: "Actual", tone: "success" };
    case "reconciled":
      return { label: "Reconciled", tone: "info" };
    case "manual":
      return { label: "Manual", tone: "info" };
    case "modeled":
      return { label: "Modeled", tone: "attention" };
    case "fallback":
      return { label: "Estimate", tone: "warning" };
    default:
      return null;
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run app/lib/ship-cost/__tests__/provenance.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the provenance fields to the `SKU` type**

In `app/lib/types.ts`, add to the `SKU` interface (after `locations_detail`):
```ts
  /** Resolved ship-cost provenance for this SKU's margin (null until resolved). */
  ship_cost_source: import("./ship-cost/types").ShipCostSource | null;
  ship_cost_confidence: import("./ship-cost/types").ShipCostConfidence | null;
```

- [ ] **Step 6: Map the fields in `rowToSku`**

In `app/lib/calderyn.server.ts`, inside `rowToSku`'s returned object, add (the underlying `v_skus_flat` view surfaces these once Plan 1's runner has written `order_fact`; until then they are null):
```ts
    ship_cost_source: (r.ship_cost_source as SKU["ship_cost_source"]) ?? null,
    ship_cost_confidence: (r.ship_cost_confidence as SKU["ship_cost_confidence"]) ?? null,
```

- [ ] **Step 7: Render the badge in the SKU table**

In `app/routes/app.skus.tsx`, add a heading and a cell. In the `headings` array (after `{ title: "Title" }`), insert:
```tsx
            { title: "Ship cost" },
```
Add the matching `false` slot to the `sortable` array (it gains one column) and update `SORT_COLUMNS` to keep indices aligned — insert a `null` after the `"title"` entry:
```ts
  const SORT_COLUMNS: (SortKey | null)[] = [
    null, "title", null, "on_hand", "days_of_cover", "velocity", null, null, null, null,
  ];
```
```tsx
          sortable={[false, true, false, true, true, true, false, false, false, false]}
```
In the row body, after the Title `IndexTable.Cell`, add:
```tsx
                <IndexTable.Cell>
                  <ShipCostBadge source={s.ship_cost_source} confidence={s.ship_cost_confidence} />
                </IndexTable.Cell>
```
And add the component near the other cell components:
```tsx
function ShipCostBadge({
  source,
  confidence,
}: {
  source: SKU["ship_cost_source"];
  confidence: SKU["ship_cost_confidence"];
}) {
  const badge = shipCostBadge(source);
  if (!badge) {
    return (
      <Text as="span" tone="subdued" variant="bodySm">
        —
      </Text>
    );
  }
  return (
    <Tooltip content={`Source: ${badge.label}${confidence ? ` · confidence ${confidence}` : ""}`}>
      <Badge tone={badge.tone}>{badge.label}</Badge>
    </Tooltip>
  );
}
```
Add the import at the top of `app.skus.tsx`: `import { shipCostBadge } from "~/lib/ship-cost/provenance";`. `Badge`, `Tooltip`, and `Text` are already imported in this file.

- [ ] **Step 8: Typecheck + build**

Run: `npm run typecheck`
Expected: exit 0.
Run: `npm run build`
Expected: exit 0.

- [ ] **Step 9: Commit**

```bash
git add app/lib/ship-cost/provenance.ts app/lib/ship-cost/__tests__/provenance.test.ts app/lib/types.ts app/lib/calderyn.server.ts app/routes/app.skus.tsx
git commit -m "skus: ship-cost provenance badge + SKU.ship_cost_source/confidence wiring"
```

---

## Task 11: Dashboard parity mirror

**Files (dashboard surface — re-implement against its own stack, do NOT port Polaris JSX):**
- Modify: `app/routes/dashboard.api.skus.tsx` (surface `ship_cost_source`/`ship_cost_confidence` in the SKU DTO)
- Modify: `app/routes/dashboard.api.guardrails.tsx` or a new `dashboard.api.ship-cost.tsx` (mode get/set, typed total, CSV upload, manual override)
- Modify: the dashboard's settings/SKU UI to render the provenance badge + the missing-weight nudge in its own primitives

> **Per CLAUDE.md dashboard-parity rule:** the merchant-facing additions in this plan (ship-cost mode, period total, CSV upload, manual override, missing-weight nudge, provenance badge) MUST be mirrored on the `dashboard.*` surface, matching the data contract — NOT copying the Polaris components. The pure helpers (`parseInvoiceCsv`, `matchInvoiceLines`, `missingWeightPct`, `shipCostBadge`, `inputs.server.ts`) are stack-agnostic and are REUSED directly; only the route loaders/actions and UI primitives are re-implemented.

- [ ] **Step 1: Reuse the pure helpers in dashboard API routes**

The dashboard API routes call the SAME `app/lib/ship-cost/inputs.server.ts` functions (`saveTypedPeriodTotal`, `ingestInvoiceCsv`, `setManualOverride`) and the SAME `missingWeightPct` / `shipCostBadge` helpers — they are not Shopify-specific. Add the ship-cost fields to the dashboard SKU DTO mapping exactly as Task 10 Step 6 did for `rowToSku`.

- [ ] **Step 2: Re-implement the UI in the dashboard's primitives**

Add a Shipping-cost panel to the dashboard settings UI (mode select, period-total form, CSV upload, per-order override) and the provenance badge + missing-weight nudge to its margin/SKU view, using the dashboard's existing component library (NOT Polaris).

- [ ] **Step 3: Verify + commit**

Run: `npm run typecheck && npm run build`
Expected: exit 0.
```bash
git add app/routes/dashboard.api.skus.tsx app/routes/dashboard.api.ship-cost.tsx
git commit -m "dashboard: mirror ship-cost inputs + provenance (matches Shopify-side data contract)"
```

> **If the dashboard side cannot ship in this pass, STOP and say so explicitly** (CLAUDE.md rule: never silently single-sided). Leave this task unchecked with a TODO referencing the Shopify-side commits, rather than marking the feature done.

---

## Final verification (pre-commit gate)

- [ ] `npm run typecheck` → exit 0
- [ ] `npm run lint` → exit 0 (`--max-warnings=0` on touched files)
- [ ] `npm run build` → exit 0
- [ ] `npx vitest run app/lib/ship-cost app/routes/__tests__/app.settings.shipcost.test.ts` → all green
- [ ] `npx prisma validate` is NOT required (no `prisma/schema.prisma` change — schema lives in Supabase migrations)
- [ ] Migrations `20260615130000_ship_cost_manual_override.sql` applied to a dev branch and verified before merge to `main`
- [ ] Confirm the manual-override path end-to-end: set an override in Settings → runner stamps `ship_cost_source='manual'` → SKU badge shows "Manual"

## Notes
- This plan consumes Plan 1's frozen names unchanged and introduces exactly one new column (`order_fact.ship_cost_manual_cents`) + one supporting table (`shop_settings`). The manual-override column closes the gap Plan 1 left when its runner hard-coded `manualOverrideCents: null`.
- All write paths (typed total, CSV ingest, manual override) end by calling `runShipCostResolution(sb, shopId, { shopCountry })`, so margins re-resolve immediately — matching the master design's "re-runs on upload/total/override" reconciliation rule.
- Task 9 (event parse) and Task 11 (dashboard mirror) are the explicitly-flagged optional / parity tasks; everything else is required for a working Shopify-side feature.
