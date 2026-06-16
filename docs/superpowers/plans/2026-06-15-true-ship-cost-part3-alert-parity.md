# True Ship Cost — Part 3: free-shipping-leakage alert + dashboard parity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a confidence-gated `free_shipping_leakage` detector, wire its two reversible actions (`raise_free_ship_threshold`, `exclude_sku_free_ship`) through the existing alert/action/undo flow, and mirror the ship-cost P&L + alert + provenance onto the dashboard surface.

**Architecture:** A pure clustering/threshold core (`app/lib/ship-cost/detect-free-ship-leakage.ts`) that turns resolved per-order ship costs into SKU- and zone-clustered leakage findings, gated on dollar-weighted aggregate confidence; a thin Supabase I/O wrapper (`.server.ts`) that reads `order_fact`/`order_line_fact`/`sku_dim`, runs the core, and idempotently upserts `alerts` keyed on `(shop_id, detector_id, entity_ref)`. Two new `ActionKind`s flow through the existing legacy execute + manual-insert undo path. Dashboard parity reuses the data-driven alert UI and adds a per-SKU shipping-P&L slice with a provenance tag.

**Tech Stack:** Remix + TypeScript (strict, no `any`), Supabase (Postgres) via `@supabase/supabase-js`, Vitest, React + Lucide via `CDIcon` (dashboard) / `@shopify/polaris-icons` (embedded admin).

**Consumes Plan 1's frozen contract** (`order_fact.ship_cost_cents|ship_cost_source|ship_cost_confidence`, `shipping_cents`, `customer_country`/`customer_region`, `order_line_fact.grams`, `sku_dim.grams`, `sku_pnl.ship_cost_cents`, `app/lib/ship-cost/zone.ts#classifyZone`, `app/lib/ship-cost/split.ts#splitOrderShipCost`). Do not rename.

---

## Task 1: Register the new detector + action kinds in the type unions

**Files:**
- Modify: `app/lib/types.ts` (the `DetectorId` and `ActionKind` unions)
- Test: `app/lib/__tests__/ship-leak-registry.test.ts`

- [ ] **Step 1: Write the failing test**

Create `app/lib/__tests__/ship-leak-registry.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { DetectorId, ActionKind } from "~/lib/types";

describe("ship-leak type registry", () => {
  it("free_shipping_leakage is a valid DetectorId", () => {
    const d: DetectorId = "free_shipping_leakage";
    expect(d).toBe("free_shipping_leakage");
  });
  it("the two free-ship actions are valid ActionKinds", () => {
    const a: ActionKind = "raise_free_ship_threshold";
    const b: ActionKind = "exclude_sku_free_ship";
    expect([a, b]).toEqual(["raise_free_ship_threshold", "exclude_sku_free_ship"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/__tests__/ship-leak-registry.test.ts`
Expected: FAIL — `tsc`/Vitest type error: `"free_shipping_leakage"` not assignable to `DetectorId`.

- [ ] **Step 3: Extend the unions**

In `app/lib/types.ts`, add to `ActionKind` (after `"create_po_draft"`):

```ts
  | "raise_free_ship_threshold"
  | "exclude_sku_free_ship"
```

And add to `DetectorId` (keep alphabetical; insert after `"cogs_drift"`):

```ts
  | "free_shipping_leakage"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/__tests__/ship-leak-registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/types.ts app/lib/__tests__/ship-leak-registry.test.ts
git commit -m "lib/types: register free_shipping_leakage detector + two free-ship action kinds"
```

---

## Task 2: Register labels, action map, evidence labels for the new detector/actions

**Files:**
- Modify: `app/lib/labels.ts` (`DETECTOR_LABELS`, `DETECTOR_TERMS`, `DETECTOR_TO_ACTIONS`, `ACTION_LABELS`, `ACTION_VERBS`, `EVIDENCE_LABELS`)
- Test: `app/lib/__tests__/ship-leak-labels.test.ts`

These maps are `Record<DetectorId,…>` / `Record<ActionKind,…>`, so after Task 1 `tsc` will already flag every map missing the new keys. This task makes those additions test-anchored.

- [ ] **Step 1: Write the failing test**

Create `app/lib/__tests__/ship-leak-labels.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  DETECTOR_LABELS,
  DETECTOR_TERMS,
  DETECTOR_TO_ACTIONS,
  ACTION_LABELS,
  ACTION_VERBS,
  EVIDENCE_LABELS,
} from "~/lib/labels";

describe("free_shipping_leakage labels", () => {
  it("has a plain label and analyst term", () => {
    expect(DETECTOR_LABELS.free_shipping_leakage).toMatch(/free ship/i);
    expect(DETECTOR_TERMS.free_shipping_leakage).toMatch(/leakage/i);
  });
  it("allows the two free-ship actions plus snooze", () => {
    expect(DETECTOR_TO_ACTIONS.free_shipping_leakage).toEqual([
      "raise_free_ship_threshold",
      "exclude_sku_free_ship",
      "snooze_alert",
    ]);
  });
  it("the two actions have labels and verbs", () => {
    expect(ACTION_LABELS.raise_free_ship_threshold).toBe("Raise free-shipping threshold");
    expect(ACTION_LABELS.exclude_sku_free_ship).toBe("Exclude SKU from free shipping");
    expect(ACTION_VERBS.raise_free_ship_threshold).toBe("Raised free-ship threshold");
    expect(ACTION_VERBS.exclude_sku_free_ship).toBe("Excluded SKU from free shipping");
  });
  it("labels the new evidence keys", () => {
    expect(EVIDENCE_LABELS.net_shipping_pnl_usd).toBe("Net shipping P&L");
    expect(EVIDENCE_LABELS.ship_cost_confidence).toBe("Ship-cost confidence");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/__tests__/ship-leak-labels.test.ts`
Expected: FAIL — keys undefined.

- [ ] **Step 3: Add the entries**

In `app/lib/labels.ts`:

In `DETECTOR_LABELS` add:
```ts
  free_shipping_leakage: "Free shipping costing more than it earns",
```
In `DETECTOR_TERMS` add:
```ts
  free_shipping_leakage: "Free-shipping leakage",
```
In `ACTION_LABELS` add:
```ts
  raise_free_ship_threshold: "Raise free-shipping threshold",
  exclude_sku_free_ship: "Exclude SKU from free shipping",
```
In `ACTION_VERBS` add:
```ts
  raise_free_ship_threshold: "Raised free-ship threshold",
  exclude_sku_free_ship: "Excluded SKU from free shipping",
```
In `EVIDENCE_LABELS` add (near the other `_usd` keys):
```ts
  shipping_collected_usd: "Shipping collected from customers",
  ship_cost_usd: "What you paid carriers",
  net_shipping_pnl_usd: "Net shipping P&L",
  free_ship_orders: "Free-shipping orders",
  ship_cost_confidence: "Ship-cost confidence",
  current_free_ship_threshold_usd: "Free-shipping threshold",
  zone: "Shipping zone",
```
In `DETECTOR_TO_ACTIONS` add:
```ts
  free_shipping_leakage: ["raise_free_ship_threshold", "exclude_sku_free_ship", "snooze_alert"],
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/__tests__/ship-leak-labels.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/labels.ts app/lib/__tests__/ship-leak-labels.test.ts
git commit -m "lib/labels: free_shipping_leakage detector labels, actions, evidence labels"
```

---

## Task 3: Pure leakage clustering + confidence-gate core

**Files:**
- Create: `app/lib/ship-cost/detect-free-ship-leakage.ts`
- Test: `app/lib/ship-cost/__tests__/detect-free-ship-leakage.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `app/lib/ship-cost/__tests__/detect-free-ship-leakage.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  detectFreeShipLeakage,
  type ShipLeakOrder,
} from "../detect-free-ship-leakage";

const order = (o: Partial<ShipLeakOrder> & { orderId: string }): ShipLeakOrder => ({
  orderId: o.orderId,
  lines: o.lines ?? [{ skuId: "sku-a", grams: 100, quantity: 1 }],
  shippingCents: o.shippingCents ?? 0,
  shipCostCents: o.shipCostCents ?? 0,
  shipCostConfidence: o.shipCostConfidence ?? "high",
  zone: o.zone ?? "domestic",
});

describe("detectFreeShipLeakage", () => {
  it("ignores orders that paid for shipping (above the free-ship threshold)", () => {
    const out = detectFreeShipLeakage([
      order({ orderId: "1", shippingCents: 800, shipCostCents: 1500 }),
    ]);
    expect(out).toEqual([]);
  });

  it("fires a SKU cluster when free-ship orders bleed money", () => {
    // 3 free-ship orders, each $25 carrier cost, $0 collected → $75 bleed.
    const orders = ["1", "2", "3"].map((id) =>
      order({ orderId: id, shippingCents: 0, shipCostCents: 2500 }),
    );
    const out = detectFreeShipLeakage(orders);
    const sku = out.find((c) => c.kind === "sku");
    expect(sku).toBeDefined();
    expect(sku!.id).toBe("sku-a");
    expect(sku!.bleedCents).toBe(7500);
    expect(sku!.freeShipOrders).toBe(3);
    expect(sku!.severity).toBe("medium"); // $75 → medium ($50 ≤ bleed < $200)
  });

  it("fires a zone cluster keyed by zone band", () => {
    const orders = ["1", "2"].map((id) =>
      order({ orderId: id, shippingCents: 0, shipCostCents: 6000, zone: "international" }),
    );
    const out = detectFreeShipLeakage(orders);
    const zone = out.find((c) => c.kind === "zone");
    expect(zone).toBeDefined();
    expect(zone!.id).toBe("international");
    expect(zone!.bleedCents).toBe(12000);
    expect(zone!.severity).toBe("medium"); // $120 → medium ($50 ≤ bleed < $200)
  });

  it("splits a multi-SKU order's ship cost across lines by weight", () => {
    // one $40 free-ship order, 2 lines 100g + 300g → sku-a gets $10, sku-b gets $30
    const out = detectFreeShipLeakage([
      order({
        orderId: "1",
        shippingCents: 0,
        shipCostCents: 4000,
        lines: [
          { skuId: "sku-a", grams: 100, quantity: 1 },
          { skuId: "sku-b", grams: 300, quantity: 1 },
        ],
      }),
    ]);
    const a = out.find((c) => c.kind === "sku" && c.id === "sku-a");
    const b = out.find((c) => c.kind === "sku" && c.id === "sku-b");
    // both below the $20 floor individually → neither fires
    expect(a).toBeUndefined();
    expect(b).toBeUndefined();
  });

  it("does NOT fire when the cluster is majority low/fallback confidence", () => {
    // big apparent bleed but dollar-weighted confidence is mostly low
    const out = detectFreeShipLeakage([
      order({ orderId: "1", shippingCents: 0, shipCostCents: 9000, shipCostConfidence: "low" }),
      order({ orderId: "2", shippingCents: 0, shipCostCents: 1000, shipCostConfidence: "high" }),
    ]);
    // 9000 low vs 1000 high → (high+med)/total = 0.1 < 0.5 → skip
    expect(out).toEqual([]);
  });

  it("fires when anchored dollars are the majority even with one big fuzzy order", () => {
    const out = detectFreeShipLeakage([
      order({ orderId: "1", shippingCents: 0, shipCostCents: 1000, shipCostConfidence: "low" }),
      order({ orderId: "2", shippingCents: 0, shipCostCents: 4000, shipCostConfidence: "high" }),
    ]);
    // (high+med)/total = 4000/5000 = 0.8 ≥ 0.5 → fires
    const sku = out.find((c) => c.kind === "sku");
    expect(sku).toBeDefined();
    expect(sku!.shipCostConfidence).toBe("high");
  });

  it("never fires on a positive net (collected ≥ cost)", () => {
    const out = detectFreeShipLeakage([
      order({ orderId: "1", shippingCents: 0, shipCostCents: 0 }),
    ]);
    expect(out).toEqual([]);
  });

  it("suppresses clusters below the $20 bleed floor", () => {
    const out = detectFreeShipLeakage([
      order({ orderId: "1", shippingCents: 0, shipCostCents: 1500 }), // $15 bleed
    ]);
    expect(out).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/ship-cost/__tests__/detect-free-ship-leakage.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the pure core**

Create `app/lib/ship-cost/detect-free-ship-leakage.ts`:

```ts
import { splitOrderShipCost, type SplitLine } from "./split";
import type { Zone } from "./zone";
import type { Severity } from "../types";
import type { ShipCostConfidence } from "./types";

/** Orders below this collected-shipping amount count as "free shipping". */
export const FREE_SHIP_THRESHOLD_CENTS = 100; // $1.00
/** Clusters whose bleed is below this never alert (noise floor). */
export const MIN_BLEED_CENTS = 2000; // $20

export interface ShipLeakLine {
  skuId: string;
  grams: number | null;
  quantity: number;
}

export interface ShipLeakOrder {
  orderId: string;
  lines: ShipLeakLine[];
  /** What the customer paid for shipping (order_fact.shipping_cents). */
  shippingCents: number;
  /** What the merchant paid the carrier (order_fact.ship_cost_cents). */
  shipCostCents: number;
  shipCostConfidence: ShipCostConfidence;
  zone: Zone;
}

export interface LeakCluster {
  kind: "sku" | "zone";
  /** sku_id for sku clusters; zone band for zone clusters. */
  id: string;
  freeShipOrders: number;
  shippingCollectedCents: number;
  shipCostCents: number;
  /** max(0, shipCost - shippingCollected). */
  bleedCents: number;
  severity: Severity;
  /** Dominant confidence tier among contributing ship-cost dollars. */
  shipCostConfidence: ShipCostConfidence;
}

interface Accum {
  freeShipOrders: number;
  shippingCollectedCents: number;
  shipCostCents: number;
  // dollar-weighted confidence buckets
  highCents: number;
  medCents: number;
  lowCents: number;
}

function emptyAccum(): Accum {
  return {
    freeShipOrders: 0,
    shippingCollectedCents: 0,
    shipCostCents: 0,
    highCents: 0,
    medCents: 0,
    lowCents: 0,
  };
}

function addConfidence(a: Accum, conf: ShipCostConfidence, costCents: number): void {
  if (conf === "high") a.highCents += costCents;
  else if (conf === "med") a.medCents += costCents;
  else a.lowCents += costCents;
}

/** Dollar-weighted: anchored (high+med) share of ship-cost dollars ≥ 50%. */
function clearsConfidenceBar(a: Accum): boolean {
  const total = a.highCents + a.medCents + a.lowCents;
  if (total <= 0) return false;
  const anchored = a.highCents + a.medCents;
  return anchored / total >= 0.5 && anchored > 0;
}

function dominantConfidence(a: Accum): ShipCostConfidence {
  if (a.highCents >= a.medCents && a.highCents >= a.lowCents) return "high";
  if (a.medCents >= a.lowCents) return "med";
  return "low";
}

function severityForBleed(bleedCents: number): Severity {
  const usd = bleedCents / 100;
  if (usd >= 500) return "critical";
  if (usd >= 200) return "high";
  if (usd >= 50) return "medium";
  return "low";
}

function finalize(kind: "sku" | "zone", id: string, a: Accum): LeakCluster | null {
  const bleedCents = Math.max(0, a.shipCostCents - a.shippingCollectedCents);
  if (bleedCents < MIN_BLEED_CENTS) return null;
  if (!clearsConfidenceBar(a)) return null;
  return {
    kind,
    id,
    freeShipOrders: a.freeShipOrders,
    shippingCollectedCents: a.shippingCollectedCents,
    shipCostCents: a.shipCostCents,
    bleedCents,
    severity: severityForBleed(bleedCents),
    shipCostConfidence: dominantConfidence(a),
  };
}

/**
 * Cluster free-shipping orders by SKU (per-line split) and by zone band, gate
 * each cluster on dollar-weighted aggregate ship-cost confidence, and return
 * the clusters that bleed money above the floor. Pure: no I/O.
 */
export function detectFreeShipLeakage(orders: ShipLeakOrder[]): LeakCluster[] {
  const bySku = new Map<string, Accum>();
  const byZone = new Map<string, Accum>();

  for (const o of orders) {
    if (o.shippingCents > FREE_SHIP_THRESHOLD_CENTS) continue; // charged for shipping
    if (o.lines.length === 0) continue;

    // Zone cluster: whole order.
    const z = byZone.get(o.zone) ?? emptyAccum();
    z.freeShipOrders += 1;
    z.shippingCollectedCents += o.shippingCents;
    z.shipCostCents += o.shipCostCents;
    addConfidence(z, o.shipCostConfidence, o.shipCostCents);
    byZone.set(o.zone, z);

    // SKU cluster: split this order's ship cost AND shipping across its lines.
    const splitLines: SplitLine[] = o.lines.map((l) => ({
      lineId: l.skuId,
      grams: l.grams,
      quantity: l.quantity,
    }));
    const costByLine = splitOrderShipCost(o.shipCostCents, splitLines);
    const shipByLine = splitOrderShipCost(o.shippingCents, splitLines);
    for (const l of o.lines) {
      const a = bySku.get(l.skuId) ?? emptyAccum();
      const costShare = costByLine.get(l.skuId) ?? 0;
      a.freeShipOrders += 1;
      a.shippingCollectedCents += shipByLine.get(l.skuId) ?? 0;
      a.shipCostCents += costShare;
      addConfidence(a, o.shipCostConfidence, costShare);
      bySku.set(l.skuId, a);
    }
  }

  const out: LeakCluster[] = [];
  for (const [id, a] of bySku) {
    const c = finalize("sku", id, a);
    if (c) out.push(c);
  }
  for (const [id, a] of byZone) {
    const c = finalize("zone", id, a);
    if (c) out.push(c);
  }
  return out;
}
```

Note on the multi-SKU test: `splitOrderShipCost` keys its returned map by `lineId`; passing `skuId` as `lineId` means a SKU appearing twice in one order would collide. v1 orders carry one line per SKU; if a future payload repeats a SKU, the wrapper (Task 4) pre-aggregates lines by `skuId` before calling the core. The core assumes one line per SKU per order.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/ship-cost/__tests__/detect-free-ship-leakage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/ship-cost/detect-free-ship-leakage.ts app/lib/ship-cost/__tests__/detect-free-ship-leakage.test.ts
git commit -m "ship-cost: pure free-shipping-leakage clustering + dollar-weighted confidence gate"
```

---

## Task 4: Supabase I/O wrapper — read facts, upsert alerts idempotently

**Files:**
- Create: `app/lib/ship-cost/detect-free-ship-leakage.server.ts`
- Test: `app/lib/ship-cost/__tests__/detect-free-ship-leakage-server.test.ts`

- [ ] **Step 1: Write the failing tests (fake Supabase client)**

Create `app/lib/ship-cost/__tests__/detect-free-ship-leakage-server.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { runFreeShipLeakageDetect } from "../detect-free-ship-leakage.server";

/**
 * Minimal fake of the supabase-js query builder we use: select+eq (reads) and
 * upsert (writes). Each table returns its seeded rows; upserts are captured.
 */
function makeFakeSupabase(tables: Record<string, Record<string, unknown>[]>) {
  const upserts: { table: string; rows: Record<string, unknown>[]; onConflict?: string }[] = [];
  const client = {
    from(table: string) {
      return {
        select() {
          return {
            eq(_col: string, _val: unknown) {
              return Promise.resolve({ data: tables[table] ?? [], error: null });
            },
          };
        },
        upsert(rows: Record<string, unknown>[], opts?: { onConflict?: string }) {
          upserts.push({ table, rows, onConflict: opts?.onConflict });
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  return { client, upserts };
}

const SHOP = "shop-1";

function baseTables() {
  return {
    order_fact: [
      { id: "o1", shop_id: SHOP, shipping_cents: 0, ship_cost_cents: 3000, ship_cost_confidence: "high", customer_country: "US" },
      { id: "o2", shop_id: SHOP, shipping_cents: 0, ship_cost_cents: 3000, ship_cost_confidence: "high", customer_country: "US" },
    ],
    order_line_fact: [
      { order_id: "o1", sku_id: "sku-a", grams: 100, quantity: 1 },
      { order_id: "o2", sku_id: "sku-a", grams: 100, quantity: 1 },
    ],
    sku_dim: [{ id: "sku-a", sku: "TEE-RED", grams: 100 }],
    shops: [{ id: SHOP, country: "US" }],
  };
}

describe("runFreeShipLeakageDetect", () => {
  it("upserts an alert row for a bleeding SKU cluster, keyed on the condition", async () => {
    const { client, upserts } = makeFakeSupabase(baseTables());
    const n = await runFreeShipLeakageDetect(client as never, SHOP);
    expect(n).toBeGreaterThan(0);
    const alertUpsert = upserts.find((u) => u.table === "alerts");
    expect(alertUpsert).toBeDefined();
    expect(alertUpsert!.onConflict).toBe("shop_id,detector_id,entity_ref");
    const skuRow = alertUpsert!.rows.find(
      (r) => (r.entity_ref as { kind: string }).kind === "sku",
    )!;
    expect(skuRow.detector_id).toBe("free_shipping_leakage");
    // $60 carrier cost, $0 collected → $60 bleed; alerts.dollar_impact is DOLLARS.
    expect(skuRow.dollar_impact).toBe(60);
    expect(skuRow.severity).toBe("medium");
    expect((skuRow.entity_ref as { sku: string }).sku).toBe("TEE-RED");
    expect((skuRow.evidence as { ship_cost_confidence: string }).ship_cost_confidence).toBe("high");
  });

  it("does NOT upsert when nothing clears the floor/confidence bar", async () => {
    const tables = baseTables();
    tables.order_fact = [
      { id: "o1", shop_id: SHOP, shipping_cents: 0, ship_cost_cents: 500, ship_cost_confidence: "high", customer_country: "US" },
    ];
    tables.order_line_fact = [{ order_id: "o1", sku_id: "sku-a", grams: 100, quantity: 1 }];
    const { client, upserts } = makeFakeSupabase(tables);
    const n = await runFreeShipLeakageDetect(client as never, SHOP);
    expect(n).toBe(0);
    expect(upserts.find((u) => u.table === "alerts")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/ship-cost/__tests__/detect-free-ship-leakage-server.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the I/O wrapper**

Create `app/lib/ship-cost/detect-free-ship-leakage.server.ts`:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { classifyZone } from "./zone";
import {
  detectFreeShipLeakage,
  type LeakCluster,
  type ShipLeakLine,
  type ShipLeakOrder,
  FREE_SHIP_THRESHOLD_CENTS,
} from "./detect-free-ship-leakage";

const DETECTOR_ID = "free_shipping_leakage";

interface OrderRow {
  id: string;
  shipping_cents: number | null;
  ship_cost_cents: number | null;
  ship_cost_confidence: "high" | "med" | "low" | null;
  customer_country: string | null;
}
interface LineRow {
  order_id: string;
  sku_id: string;
  grams: number | null;
  quantity: number | null;
}
interface SkuRow {
  id: string;
  sku: string | null;
}
interface ShopRow {
  id: string;
  country: string | null;
}

const usd = (cents: number): string => (cents / 100).toFixed(2);

/** Plain-language narrative for a fired cluster. */
function narrate(c: LeakCluster, skuCode: string | null): string {
  const who = c.kind === "sku" ? `the SKU ${skuCode ?? c.id}` : `${c.id} orders`;
  return (
    `Free shipping on ${who} cost you $${usd(c.bleedCents)} more to ship than ` +
    `customers paid, across ${c.freeShipOrders} order${c.freeShipOrders === 1 ? "" : "s"}.`
  );
}

/**
 * Read this shop's resolved orders, cluster free-shipping leakage by SKU and
 * zone, and idempotently upsert one alert per standing condition (keyed on
 * shop_id+detector_id+entity_ref via alerts_active_condition_key). Returns the
 * number of alerts upserted. Surfaces read errors loudly (rule 12).
 */
export async function runFreeShipLeakageDetect(
  sb: SupabaseClient,
  shopId: string,
): Promise<number> {
  const [ordersRes, linesRes, skusRes, shopRes] = await Promise.all([
    sb
      .from("order_fact")
      .select("id, shipping_cents, ship_cost_cents, ship_cost_confidence, customer_country")
      .eq("shop_id", shopId),
    sb.from("order_line_fact").select("order_id, sku_id, grams, quantity").eq("shop_id", shopId),
    sb.from("sku_dim").select("id, sku").eq("shop_id", shopId),
    sb.from("shops").select("id, country").eq("id", shopId),
  ]);
  for (const [name, res] of [
    ["order_fact", ordersRes],
    ["order_line_fact", linesRes],
    ["sku_dim", skusRes],
    ["shops", shopRes],
  ] as const) {
    if (res.error) throw new Error(`free-ship-leakage read ${name}: ${res.error.message}`);
  }

  const orders = (ordersRes.data ?? []) as OrderRow[];
  const lines = (linesRes.data ?? []) as LineRow[];
  const skus = (skusRes.data ?? []) as SkuRow[];
  const shopCountry = ((shopRes.data ?? [])[0] as ShopRow | undefined)?.country ?? null;

  const skuCodeById = new Map<string, string | null>(skus.map((s) => [s.id, s.sku ?? null]));

  // Pre-aggregate lines per order by sku_id so a SKU repeated on one order
  // collapses to a single line (the core assumes one line per SKU per order).
  const linesByOrder = new Map<string, Map<string, ShipLeakLine>>();
  for (const l of lines) {
    const perOrder = linesByOrder.get(l.order_id) ?? new Map<string, ShipLeakLine>();
    const prev = perOrder.get(l.sku_id);
    const grams = l.grams ?? null;
    const qty = l.quantity ?? 1;
    if (prev) {
      prev.quantity += qty;
      prev.grams = prev.grams != null && grams != null ? prev.grams + grams : prev.grams ?? grams;
    } else {
      perOrder.set(l.sku_id, { skuId: l.sku_id, grams, quantity: qty });
    }
    linesByOrder.set(l.order_id, perOrder);
  }

  const leakOrders: ShipLeakOrder[] = orders.map((o) => ({
    orderId: o.id,
    lines: [...(linesByOrder.get(o.id)?.values() ?? [])],
    shippingCents: o.shipping_cents ?? 0,
    shipCostCents: o.ship_cost_cents ?? 0,
    shipCostConfidence: o.ship_cost_confidence ?? "low",
    zone: classifyZone(shopCountry, o.customer_country),
  }));

  const clusters = detectFreeShipLeakage(leakOrders);
  if (clusters.length === 0) return 0;

  // Rank by bleed desc (engine convention: claude_rank 1 = worst).
  const ranked = [...clusters].sort((a, b) => b.bleedCents - a.bleedCents);
  const today = new Date().toISOString().slice(0, 10);

  const rows = ranked.map((c, i) => {
    const skuCode = c.kind === "sku" ? skuCodeById.get(c.id) ?? null : null;
    const entityRef =
      c.kind === "sku"
        ? { kind: "sku" as const, id: c.id, sku: skuCode, zone: null }
        : { kind: "zone" as const, id: c.id, zone: c.id };
    return {
      shop_id: shopId,
      detector_id: DETECTOR_ID,
      entity_ref: entityRef,
      status: "open",
      severity: c.severity,
      dollar_impact: c.bleedCents / 100, // alerts.dollar_impact is DOLLARS
      day_bucket: today,
      claude_rank: i + 1,
      claude_narrative: narrate(c, skuCode),
      last_seen_at: new Date().toISOString(),
      evidence: {
        cluster_kind: c.kind,
        ...(skuCode ? { sku: skuCode } : {}),
        ...(c.kind === "zone" ? { zone: c.id } : {}),
        free_ship_orders: c.freeShipOrders,
        shipping_collected_usd: usd(c.shippingCollectedCents),
        ship_cost_usd: usd(c.shipCostCents),
        net_shipping_pnl_usd: usd(c.shippingCollectedCents - c.shipCostCents),
        ship_cost_confidence: c.shipCostConfidence,
        current_free_ship_threshold_usd: usd(FREE_SHIP_THRESHOLD_CENTS),
      },
    };
  });

  const { error } = await sb
    .from("alerts")
    .upsert(rows, { onConflict: "shop_id,detector_id,entity_ref" });
  if (error) throw new Error(`free-ship-leakage upsert alerts: ${error.message}`);
  return rows.length;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/ship-cost/__tests__/detect-free-ship-leakage-server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/ship-cost/detect-free-ship-leakage.server.ts app/lib/ship-cost/__tests__/detect-free-ship-leakage-server.test.ts
git commit -m "ship-cost: free-ship-leakage I/O wrapper — read facts, idempotent alerts upsert"
```

---

## Task 5: Wire the detector into the detect pass

**Files:**
- Modify: the per-shop detector dispatch (the route serving `POST /api/engine/run`, referenced by `app/routes/cron.detect.tsx`). Locate it first: `git grep -l "api/engine/run\|engine.run\|runDetectors" app/routes app/lib`. It is `app/routes/api.engine.run.tsx` (the route matching `/api/engine/run`).
- Test: `app/lib/ship-cost/__tests__/detect-free-ship-leakage-wiring.test.ts`

- [ ] **Step 1: Locate the engine-run handler and read it**

Run: `git grep -n "free_shipping_leakage\|runFreeShipLeakageDetect\|alert_ids\|shop_id" app/routes/api.engine.run.tsx`
Read the file. It authorizes the cron bearer token, reads `shop_id` from the JSON body, runs the detector suite for that shop, and returns `{ shop_id, alert_ids }`. The new detector slots into that suite.

- [ ] **Step 2: Write the failing wiring test**

Create `app/lib/ship-cost/__tests__/detect-free-ship-leakage-wiring.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";

// The wiring test asserts the engine-run handler invokes the detector once for
// the requested shop. Mock the detector and the supabase factory.
const runFreeShipLeakageDetect = vi.fn().mockResolvedValue(2);
vi.mock("~/lib/ship-cost/detect-free-ship-leakage.server", () => ({
  runFreeShipLeakageDetect: (...a: unknown[]) => runFreeShipLeakageDetect(...a),
}));
vi.mock("~/lib/cron-auth.server", () => ({ isAuthorizedCron: () => true }));
vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => ({ __fake: true }) }));

import { action as engineRun } from "~/routes/api.engine.run";

describe("engine run wires free_shipping_leakage", () => {
  it("calls runFreeShipLeakageDetect once for the requested shop", async () => {
    const req = new Request("http://x/api/engine/run", {
      method: "POST",
      headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({ shop_id: "shop-1" }),
    });
    await engineRun({ request: req, params: {}, context: {} } as never);
    expect(runFreeShipLeakageDetect).toHaveBeenCalledTimes(1);
    expect(runFreeShipLeakageDetect).toHaveBeenCalledWith({ __fake: true }, "shop-1");
  });
});
```

If the engine-run handler exports a `loader` (GET) rather than an `action`, adjust the import/handler name and HTTP method to match what Step 1 found; keep the assertion identical.

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run app/lib/ship-cost/__tests__/detect-free-ship-leakage-wiring.test.ts`
Expected: FAIL — `runFreeShipLeakageDetect` not called (not yet wired).

- [ ] **Step 4: Wire it into the handler**

In `app/routes/api.engine.run.tsx`, import and invoke the detector inside the per-shop run, capturing nothing more than its count (the route already aggregates `alert_ids` from the existing engine; this detector upserts directly and contributes its count to the response if the handler tallies counts). Add near the other detector calls:

```ts
import { runFreeShipLeakageDetect } from "~/lib/ship-cost/detect-free-ship-leakage.server";
// ... inside the per-shop block, after the existing detectors run for `shop_id`:
try {
  await runFreeShipLeakageDetect(sb, shop_id);
} catch (err) {
  // One detector's failure must not abort the rest of the suite (rule 12).
  console.error(`[engine.run] free_shipping_leakage failed for shop ${shop_id}`, err);
}
```

Use the handler's existing supabase handle (named `sb` per Step 1's read; rename to match) and its existing `shop_id` variable.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run app/lib/ship-cost/__tests__/detect-free-ship-leakage-wiring.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/routes/api.engine.run.tsx app/lib/ship-cost/__tests__/detect-free-ship-leakage-wiring.test.ts
git commit -m "engine.run: invoke free_shipping_leakage detector in the per-shop detect pass"
```

---

## Task 6: propose_action — accept the two new action kinds

**Files:**
- Modify: `app/lib/assistant/tools.server.ts` (the `propose_action` tool's `action_kind` enum)
- Test: `app/lib/assistant/__tests__/tools.test.ts` (add cases)

- [ ] **Step 1: Write the failing test**

Append to `app/lib/assistant/__tests__/tools.test.ts` (inside its top-level describe). It uses the existing pattern in that file — a fake `CalderynClient` whose `alerts.get` returns an alert. Adapt to that file's existing helper for building the dispatcher; if it has a `makeClient`/`fakeClient` helper, reuse it. Minimal standalone version:

```ts
import { makeToolDispatcher } from "~/lib/assistant/tools.server";

describe("propose_action — free-ship actions", () => {
  const alert = {
    id: "a1",
    detector_id: "free_shipping_leakage",
    severity: "high",
    status: "open",
    dollar_impact: 6000,
    claude_rank: 1,
    created_at: "2026-06-15T00:00:00Z",
    title: "Free shipping leakage",
    narrative: "",
    campaign: null,
    sku: "TEE-RED",
    evidence: { cluster_kind: "sku", sku: "TEE-RED" },
  };
  const client = {
    alerts: { get: async () => alert },
  } as unknown as Parameters<typeof makeToolDispatcher>[0];

  it("allows raise_free_ship_threshold for free_shipping_leakage", async () => {
    const dispatch = makeToolDispatcher(client);
    const res = await dispatch("propose_action", {
      alert_id: "a1",
      action_kind: "raise_free_ship_threshold",
    });
    expect(res.isError).toBeFalsy();
    expect(res.draftedAction?.actionKind).toBe("raise_free_ship_threshold");
    expect(res.draftedAction?.label).toBe("Raise free-shipping threshold");
  });

  it("rejects raise_free_ship_threshold for a campaign detector", async () => {
    const campaignAlert = { ...alert, detector_id: "campaign_below_breakeven", sku: null };
    const dispatch = makeToolDispatcher({
      alerts: { get: async () => campaignAlert },
    } as unknown as Parameters<typeof makeToolDispatcher>[0]);
    const res = await dispatch("propose_action", {
      alert_id: "a1",
      action_kind: "raise_free_ship_threshold",
    });
    expect(res.isError).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/assistant/__tests__/tools.test.ts -t "free-ship actions"`
Expected: FAIL — the `propose_action` enum rejects `raise_free_ship_threshold` (validation happens against `DETECTOR_TO_ACTIONS`, which now allows it after Task 2, but the tool's input-schema `enum` does not list it, and a strict caller would reject it). The allow check passes via labels, so the binding failure is the enum omission — fix in Step 3.

- [ ] **Step 3: Add the kinds to the propose_action enum**

In `app/lib/assistant/tools.server.ts`, in the `propose_action` tool's `action_kind.enum` array, append:

```ts
            "raise_free_ship_threshold",
            "exclude_sku_free_ship",
```

(`proposeAction()` itself already validates against `DETECTOR_TO_ACTIONS[alert.detector_id]` and uses `ACTION_LABELS[actionKind]`, both populated in Task 2 — no further change needed there.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/assistant/__tests__/tools.test.ts -t "free-ship actions"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/assistant/tools.server.ts app/lib/assistant/__tests__/tools.test.ts
git commit -m "assistant/propose_action: allow raise_free_ship_threshold + exclude_sku_free_ship"
```

---

## Task 7: Action executor — derive payloads, guardrail-cap, undo-friendly

**Files:**
- Create: `app/lib/actions/free-ship-action.server.ts`
- Test: `app/lib/actions/__tests__/free-ship-action.test.ts`

This mirrors `app/lib/actions/alert-action.server.ts`: re-derive the mutation inputs from the alert record (never the request body), enforce the per-action dollar cap, record via `client.actions.execute`, then acknowledge the alert. The two kinds are non-platform (no Shopify write in v1) — they record the policy decision + estimate reversibly.

- [ ] **Step 1: Write the failing tests**

Create `app/lib/actions/__tests__/free-ship-action.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { executeFreeShipAlertAction } from "../free-ship-action.server";
import { CalderynError } from "~/lib/calderyn.server";

function makeClient(alert: Record<string, unknown>, capCents = 1_000_00) {
  const execute = vi.fn(async (opts: { params: Record<string, unknown> }) => ({
    id: "audit-1",
    outcome: "succeeded",
    params: opts.params,
  }));
  return {
    execute,
    client: {
      alerts: { get: async () => alert },
      guardrails: { get: async () => ({ dollar_cap_cents: capCents }) },
      actions: { execute },
    },
  };
}

const skuAlert = {
  id: "a1",
  detector_id: "free_shipping_leakage",
  status: "open",
  dollar_impact: 6000, // cents
  campaign: null,
  sku: "TEE-RED",
  evidence: {
    cluster_kind: "sku",
    sku: "TEE-RED",
    sku_id: "sku-uuid-a",
    current_free_ship_threshold_usd: "1.00",
  },
};

describe("executeFreeShipAlertAction", () => {
  it("exclude_sku_free_ship records sku_id + excluded:true, acknowledges", async () => {
    const { client, execute } = makeClient(skuAlert);
    const ack = vi.fn(async () => true);
    const res = await executeFreeShipAlertAction({
      client: client as never,
      shopId: "shop-1",
      alertId: "a1",
      kind: "exclude_sku_free_ship",
      idempotencyKey: "idem-1",
      acknowledge: ack,
    });
    expect(execute).toHaveBeenCalledTimes(1);
    const params = execute.mock.calls[0][0].params;
    expect(params.sku_id).toBe("sku-uuid-a");
    expect(params.excluded).toBe(true);
    expect(res.acknowledged).toBe(true);
  });

  it("raise_free_ship_threshold computes a suggested threshold above per-order cost", async () => {
    const { client, execute } = makeClient(skuAlert);
    await executeFreeShipAlertAction({
      client: client as never,
      shopId: "shop-1",
      alertId: "a1",
      kind: "raise_free_ship_threshold",
      idempotencyKey: "idem-2",
      acknowledge: async () => true,
    });
    const params = execute.mock.calls[0][0].params;
    expect(typeof params.suggested_threshold_cents).toBe("number");
    expect(params.suggested_threshold_cents as number).toBeGreaterThan(
      params.prev_threshold_cents as number,
    );
  });

  it("rejects exclude_sku_free_ship for a zone cluster (no sku_id)", async () => {
    const zoneAlert = {
      ...skuAlert,
      sku: null,
      evidence: { cluster_kind: "zone", zone: "international" },
    };
    const { client } = makeClient(zoneAlert);
    await expect(
      executeFreeShipAlertAction({
        client: client as never,
        shopId: "shop-1",
        alertId: "a1",
        kind: "exclude_sku_free_ship",
        idempotencyKey: "idem-3",
        acknowledge: async () => true,
      }),
    ).rejects.toBeInstanceOf(CalderynError);
  });

  it("enforces the per-action dollar cap", async () => {
    const { client } = makeClient(skuAlert, 50_00); // $50 cap, bleed is $60
    await expect(
      executeFreeShipAlertAction({
        client: client as never,
        shopId: "shop-1",
        alertId: "a1",
        kind: "raise_free_ship_threshold",
        idempotencyKey: "idem-4",
        acknowledge: async () => true,
      }),
    ).rejects.toMatchObject({ code: "guardrail_dollar_cap" });
  });

  it("rejects when the alert is not open", async () => {
    const { client } = makeClient({ ...skuAlert, status: "acknowledged" });
    await expect(
      executeFreeShipAlertAction({
        client: client as never,
        shopId: "shop-1",
        alertId: "a1",
        kind: "raise_free_ship_threshold",
        idempotencyKey: "idem-5",
        acknowledge: async () => true,
      }),
    ).rejects.toMatchObject({ code: "alert_not_open" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/actions/__tests__/free-ship-action.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the executor**

Create `app/lib/actions/free-ship-action.server.ts`:

```ts
import { CalderynError } from "../calderyn.server";
import { DETECTOR_TO_ACTIONS } from "../labels";
import { fmtMoney } from "../format";
import type { ActionKind, Alert, AuditEntry, GuardrailConfig, DetectorId } from "../types";

export type FreeShipActionKind = "raise_free_ship_threshold" | "exclude_sku_free_ship";

/** Slice of calderynClient(shop) this executor needs (keeps tests honest). */
export interface FreeShipActionClient {
  alerts: { get(id: string, signal?: AbortSignal): Promise<Alert> };
  guardrails: { get(signal?: AbortSignal): Promise<GuardrailConfig> };
  actions: {
    execute(opts: {
      alertId: string | null;
      kind: ActionKind;
      params: Record<string, unknown>;
      idempotencyKey: string;
    }): Promise<AuditEntry>;
  };
}

// A buffer over the per-order carrier cost so the bleeding orders no longer
// qualify for free shipping (cents). Tunable later in Settings (phase 2).
const THRESHOLD_BUFFER_CENTS = 500;

function dollarsToCents(usd: unknown): number {
  const n = Number(usd);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/**
 * Execute a free-shipping leakage action against a shop-scoped alert. Inputs
 * are re-derived from the alert evidence, never the request body. Both kinds
 * are non-platform in v1: they record the merchant's reversible policy decision
 * + recovered-impact estimate. TODO(phase-2): write the Shopify shipping-profile
 * / discount mutation that actually enforces the change.
 */
export async function executeFreeShipAlertAction(opts: {
  client: FreeShipActionClient;
  shopId: string;
  alertId: string;
  kind: FreeShipActionKind;
  idempotencyKey: string;
  /** Flip the alert to acknowledged after a successful action. */
  acknowledge: (alertId: string) => Promise<boolean>;
  signal?: AbortSignal;
}): Promise<{ auditId: string; outcome: string; acknowledged: boolean }> {
  const { client, alertId, kind, idempotencyKey, acknowledge, signal } = opts;

  const alert = await client.alerts.get(alertId, signal);

  if (alert.status !== "open") {
    throw new CalderynError({
      code: "alert_not_open",
      status: 409,
      message: `This alert is ${alert.status}; actions only apply to open alerts.`,
    });
  }

  const allowed = DETECTOR_TO_ACTIONS[alert.detector_id as DetectorId] ?? ["snooze_alert"];
  if (!allowed.includes(kind)) {
    throw new CalderynError({
      code: "action_not_allowed",
      status: 403,
      message: `"${kind}" is not a permitted action for this alert.`,
    });
  }

  // Per-action dollar cap from the alert's real impact (same rule as inventory).
  const guardrails = await client.guardrails.get(signal);
  if (alert.dollar_impact > guardrails.dollar_cap_cents) {
    throw new CalderynError({
      code: "guardrail_dollar_cap",
      status: 403,
      message: `This action's impact (${fmtMoney(alert.dollar_impact)}) exceeds the per-action cap of ${fmtMoney(guardrails.dollar_cap_cents)}.`,
    });
  }

  const ev = alert.evidence ?? {};
  const prevThresholdCents = dollarsToCents(ev.current_free_ship_threshold_usd);

  const params: Record<string, unknown> = {
    target: alert.sku ?? String(ev.zone ?? ""),
    estimate_cents: alert.dollar_impact,
    cluster_kind: ev.cluster_kind ?? null,
  };

  if (kind === "exclude_sku_free_ship") {
    const skuId = ev.sku_id;
    if (!skuId || ev.cluster_kind !== "sku") {
      throw new CalderynError({
        code: "invalid_free_ship_evidence",
        status: 422,
        message: "Excluding a SKU from free shipping requires a SKU-cluster alert with a sku_id.",
      });
    }
    params.sku_id = skuId;
    params.sku = ev.sku ?? alert.sku ?? "";
    params.excluded = true; // post-state; undo flips to false
  } else {
    // raise_free_ship_threshold: per-order carrier cost = ship_cost / orders.
    const shipCostCents = dollarsToCents(ev.ship_cost_usd);
    const orders = Number(ev.free_ship_orders ?? 1) || 1;
    const perOrderCostCents = Math.round(shipCostCents / orders);
    params.prev_threshold_cents = prevThresholdCents;
    params.suggested_threshold_cents = perOrderCostCents + THRESHOLD_BUFFER_CENTS;
  }

  const audit = await client.actions.execute({ alertId, kind, params, idempotencyKey });
  const acknowledged = await acknowledge(alertId);

  return { auditId: audit.id, outcome: audit.outcome ?? "succeeded", acknowledged };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/actions/__tests__/free-ship-action.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/actions/free-ship-action.server.ts app/lib/actions/__tests__/free-ship-action.test.ts
git commit -m "actions: free-ship leakage executor — derive payloads, dollar-cap, ack"
```

---

## Task 8: Dashboard alert-action route — accept the two free-ship kinds

**Files:**
- Modify: `app/routes/dashboard.api.alerts.$id.action.tsx`
- Test: `app/lib/dashboard/__tests__/api-write-routes.test.ts` (add cases) OR a new focused test `app/routes/__tests__/free-ship-action-route.test.ts`

- [ ] **Step 1: Write the failing test**

Create `app/routes/__tests__/free-ship-action-route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const requireDashboardSession = vi.fn();
const requireSameOrigin = vi.fn();
const executeFreeShipAlertAction = vi.fn();
const calderynClient = vi.fn();
const acknowledgeAlert = vi.fn().mockResolvedValue(true);

vi.mock("~/lib/dashboard/session.server", () => ({
  requireDashboardSession: (...a: unknown[]) => requireDashboardSession(...a),
}));
vi.mock("~/lib/dashboard/http.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/dashboard/http.server")>()),
  requireSameOrigin: (...a: unknown[]) => requireSameOrigin(...a),
}));
vi.mock("~/lib/calderyn.server", () => ({ calderynClient: (...a: unknown[]) => calderynClient(...a) }));
vi.mock("~/lib/alerts.server", () => ({ acknowledgeAlert: (...a: unknown[]) => acknowledgeAlert(...a) }));
vi.mock("~/lib/actions/free-ship-action.server", () => ({
  executeFreeShipAlertAction: (...a: unknown[]) => executeFreeShipAlertAction(...a),
}));
vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => ({ __fake: true }) }));

import { action } from "~/routes/dashboard.api.alerts.$id.action";

beforeEach(() => {
  vi.clearAllMocks();
  requireDashboardSession.mockResolvedValue({
    shopId: "shop-1",
    shopDomain: "x.myshopify.com",
  });
  executeFreeShipAlertAction.mockResolvedValue({
    auditId: "audit-1",
    outcome: "succeeded",
    acknowledged: true,
  });
});

function post(body: unknown) {
  const req = new Request("http://x/dashboard/api/alerts/a1/action", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return action({ request: req, params: { id: "a1" }, context: {} } as never);
}

describe("POST /dashboard/api/alerts/:id/action — free-ship kinds", () => {
  it("routes raise_free_ship_threshold to executeFreeShipAlertAction", async () => {
    const res = await post({ type: "raise_free_ship_threshold", idempotency_key: "k1" });
    expect(executeFreeShipAlertAction).toHaveBeenCalledTimes(1);
    const json = (await (res as Response).json()) as { audit_id: string };
    expect(json.audit_id).toBe("audit-1");
  });

  it("routes exclude_sku_free_ship to executeFreeShipAlertAction", async () => {
    await post({ type: "exclude_sku_free_ship", idempotency_key: "k2" });
    expect(executeFreeShipAlertAction).toHaveBeenCalledTimes(1);
  });

  it("422s an unknown action type", async () => {
    const res = await post({ type: "nope", idempotency_key: "k3" });
    expect((res as Response).status).toBe(422);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/routes/__tests__/free-ship-action-route.test.ts`
Expected: FAIL — the route only knows the inventory kinds; `raise_free_ship_threshold` falls into `invalid_action_type` (422) and the executor is never called.

- [ ] **Step 3: Branch the route on action kind**

Edit `app/routes/dashboard.api.alerts.$id.action.tsx`. Add the free-ship kinds and dispatch them to the new executor; leave the inventory path unchanged. Replace the kind handling so it covers both families:

```ts
import {
  executeFreeShipAlertAction,
  type FreeShipActionKind,
} from "~/lib/actions/free-ship-action.server";
import { acknowledgeAlert } from "~/lib/alerts.server";

const INVENTORY_KINDS: InventoryAlertActionKind[] = ["reallocate_inventory", "snooze_alert"];
const FREE_SHIP_KINDS: FreeShipActionKind[] = [
  "raise_free_ship_threshold",
  "exclude_sku_free_ship",
];
```

Then in `action`, after parsing `body` and reading `kind = body.type` + `idempotencyKey`:

```ts
  const kind = String(body.type ?? "");
  const idempotencyKey = String(body.idempotency_key ?? "");
  if (!idempotencyKey) return jsonError(422, "missing_idempotency_key");

  const alertId = String(params.id);
  const client = calderynClient(session.shopDomain);
  const sb = getSupabase();

  if ((FREE_SHIP_KINDS as string[]).includes(kind)) {
    return dashboardJson(async () => {
      const { auditId, outcome, acknowledged } = await executeFreeShipAlertAction({
        client,
        shopId: session.shopId,
        alertId,
        kind: kind as FreeShipActionKind,
        idempotencyKey,
        acknowledge: (id) => acknowledgeAlert(sb, session.shopId, id),
        signal: request.signal,
      });
      return { audit_id: auditId, outcome, acknowledged };
    });
  }

  if (!(INVENTORY_KINDS as string[]).includes(kind)) {
    return jsonError(422, "invalid_action_type");
  }

  // ...existing inventory path unchanged (unauthenticated.admin → executeInventoryAlertAction)...
```

Keep the existing inventory branch below this, unchanged. (The `calderynClient` slice satisfies `FreeShipActionClient` — it exposes `alerts.get`, `guardrails.get`, `actions.execute`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/routes/__tests__/free-ship-action-route.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/routes/dashboard.api.alerts.$id.action.tsx app/routes/__tests__/free-ship-action-route.test.ts
git commit -m "dashboard/alerts action: route free-ship kinds to the free-ship executor"
```

---

## Task 9: Dashboard `adaptAlert` — surface the two free-ship actions

**Files:**
- Modify: `app/lib/dashboard/client.ts` (`adaptAlert` action builder + `AUDIT_VERBS`)
- Test: `app/lib/dashboard/__tests__/adapt-alert.test.ts` (add cases)

- [ ] **Step 1: Write the failing test**

Append to `app/lib/dashboard/__tests__/adapt-alert.test.ts`:

```ts
import { adaptAlert } from "~/lib/dashboard/client";
import type { Alert } from "~/lib/types";

describe("adaptAlert — free_shipping_leakage", () => {
  const base: Alert = {
    id: "a1",
    detector_id: "free_shipping_leakage",
    severity: "high",
    status: "open",
    dollar_impact: 6000,
    claude_rank: 1,
    created_at: "2026-06-15T00:00:00Z",
    title: "Free shipping leakage",
    narrative: "",
    campaign: null,
    sku: "TEE-RED",
    evidence: { cluster_kind: "sku", sku: "TEE-RED", ship_cost_confidence: "high" },
  };

  it("emits both free-ship actions + snooze, recommends the first", () => {
    const vm = adaptAlert(base, []);
    expect(vm.actions).toEqual([
      "raise_free_ship_threshold",
      "exclude_sku_free_ship",
      "snooze_alert",
    ]);
    expect(vm.recommended).toBe("raise_free_ship_threshold");
  });

  it("omits exclude_sku_free_ship for a zone cluster", () => {
    const zone: Alert = {
      ...base,
      sku: null,
      evidence: { cluster_kind: "zone", zone: "international" },
    };
    const vm = adaptAlert(zone, []);
    expect(vm.actions).toEqual(["raise_free_ship_threshold", "snooze_alert"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/dashboard/__tests__/adapt-alert.test.ts -t "free_shipping_leakage"`
Expected: FAIL — current `adaptAlert` only emits campaign/inventory/snooze; the free-ship kinds are absent.

- [ ] **Step 3: Extend the action builder**

In `app/lib/dashboard/client.ts`, inside `adaptAlert`, after computing `detectorActions`, build the free-ship actions before assembling `actions`:

```ts
  const detectorActions = DETECTOR_TO_ACTIONS[a.detector_id] ?? [];

  // Free-shipping leakage exposes its own dashboard-executable kinds. exclude
  // only when the cluster is a SKU cluster (the executor 422s a zone cluster).
  const isSkuCluster =
    a.detector_id === "free_shipping_leakage" && a.evidence?.cluster_kind === "sku";
  const freeShipActions: string[] = detectorActions.includes("raise_free_ship_threshold")
    ? [
        "raise_free_ship_threshold",
        ...(isSkuCluster ? ["exclude_sku_free_ship"] : []),
      ]
    : [];

  const actions: string[] = [
    ...(campaign_id ? ["pause_campaign", "reduce_campaign_budget"] : []),
    ...(detectorActions.includes("reallocate_inventory") ? ["reallocate_inventory"] : []),
    ...freeShipActions,
    "snooze_alert",
  ];
```

Also add to `AUDIT_VERBS` in the same file:

```ts
  raise_free_ship_threshold: "Raised free-ship threshold",
  exclude_sku_free_ship: "Excluded SKU from free shipping",
```

(`evidence` values are coerced to strings by `adaptAlert` for the VM, but the builder reads the raw `a.evidence.cluster_kind` before coercion — confirm the read uses `a.evidence`, the source Alert, not the coerced map. In the current code `a.evidence` is the raw `Record<string, unknown>`, so `a.evidence?.cluster_kind === "sku"` is a valid comparison.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/dashboard/__tests__/adapt-alert.test.ts -t "free_shipping_leakage"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/dashboard/client.ts app/lib/dashboard/__tests__/adapt-alert.test.ts
git commit -m "dashboard/adaptAlert: surface free-ship actions (SKU-cluster gates exclude)"
```

---

## Task 10: Dashboard action-button icons + provenance tag helper

**Files:**
- Modify: `app/components/dashboard/icons.tsx` (`CD_ICONS` registry + `CD_ACTION_ICON`)
- Modify: `app/components/dashboard/ui.tsx` (add `ProvenanceTag`)
- Test: `app/components/dashboard/__tests__/provenance-tag.test.ts`

- [ ] **Step 1: Write the failing test**

Create `app/components/dashboard/__tests__/provenance-tag.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { provenanceLabel } from "../ui";

describe("provenanceLabel", () => {
  it("maps ship_cost_source/confidence to a merchant label", () => {
    expect(provenanceLabel("actual_invoice")).toBe("Actual");
    expect(provenanceLabel("actual_event")).toBe("Actual");
    expect(provenanceLabel("reconciled")).toBe("Reconciled");
    expect(provenanceLabel("modeled")).toBe("Modeled");
    expect(provenanceLabel("fallback")).toBe("Fallback");
    expect(provenanceLabel("manual")).toBe("Manual");
  });
  it("falls back to Modeled for an unknown source", () => {
    expect(provenanceLabel("???")).toBe("Modeled");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/components/dashboard/__tests__/provenance-tag.test.ts`
Expected: FAIL — `provenanceLabel` not exported.

- [ ] **Step 3: Implement the helper + register icons**

In `app/components/dashboard/ui.tsx`, add (near the other small exports):

```ts
/** ship_cost_source → merchant-facing provenance label. */
export function provenanceLabel(source: string): string {
  switch (source) {
    case "actual_invoice":
    case "actual_event":
      return "Actual";
    case "reconciled":
      return "Reconciled";
    case "fallback":
      return "Fallback";
    case "manual":
      return "Manual";
    case "modeled":
    default:
      return "Modeled";
  }
}

/** Small inline provenance pill for a ship-cost number. */
export function ProvenanceTag({ source }: { source: string }) {
  const label = provenanceLabel(source);
  const tone = label === "Actual" ? "success" : label === "Fallback" ? "warn" : "neutral";
  return <Pill tone={tone}>{label}</Pill>;
}
```

If `Pill`'s `tone` prop does not accept `"neutral"`/`"warn"`, use the tones it does accept (read `Pill`'s definition at the top of `ui.tsx`); the test only binds `provenanceLabel`, so the `ProvenanceTag` tones can match whatever `Pill` supports.

In `app/components/dashboard/icons.tsx`, add Lucide icons to the registry (one line each) and map the two actions. Import `Truck` and `Ban` from `lucide-react`, add to `CD_ICONS`:

```ts
  truck: Truck,
  ban: Ban,
```

and to `CD_ACTION_ICON`:

```ts
  raise_free_ship_threshold: "truck",
  exclude_sku_free_ship: "ban",
```

(Do not hand-draw SVGs; do not use Polaris icons here — this is the dashboard surface.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/components/dashboard/__tests__/provenance-tag.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/components/dashboard/ui.tsx app/components/dashboard/icons.tsx app/components/dashboard/__tests__/provenance-tag.test.ts
git commit -m "dashboard/ui+icons: ProvenanceTag helper + Lucide icons for free-ship actions"
```

---

## Task 11: Analytics ship-P&L slice — view-model + client adapter

**Files:**
- Modify: `app/components/dashboard/view-models.ts` (add `ShipPnlRow`)
- Modify: `app/lib/dashboard/client.ts` (`AnalyticsEnvelope` + `fetchAnalytics` map `ship_pnl`)
- Test: `app/lib/dashboard/__tests__/adapt-ship-pnl.test.ts`

- [ ] **Step 1: Write the failing test**

Create `app/lib/dashboard/__tests__/adapt-ship-pnl.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { adaptShipPnl, type ShipPnlApiRow } from "~/lib/dashboard/client";

describe("adaptShipPnl", () => {
  it("maps API rows to ShipPnlRow with net + provenance", () => {
    const rows: ShipPnlApiRow[] = [
      {
        sku: "TEE-RED",
        title: "Red Tee",
        shipping_collected_cents: 0,
        ship_cost_cents: 6000,
        ship_cost_source: "reconciled",
      },
    ];
    const vms = adaptShipPnl(rows);
    expect(vms).toEqual([
      {
        sku: "TEE-RED",
        title: "Red Tee",
        shipping_collected_cents: 0,
        ship_cost_cents: 6000,
        net_shipping_pnl_cents: -6000,
        ship_cost_source: "reconciled",
      },
    ]);
  });

  it("sorts worst (most negative) net first", () => {
    const vms = adaptShipPnl([
      { sku: "A", title: "A", shipping_collected_cents: 0, ship_cost_cents: 1000, ship_cost_source: "modeled" },
      { sku: "B", title: "B", shipping_collected_cents: 0, ship_cost_cents: 9000, ship_cost_source: "reconciled" },
    ]);
    expect(vms.map((v) => v.sku)).toEqual(["B", "A"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/dashboard/__tests__/adapt-ship-pnl.test.ts`
Expected: FAIL — `adaptShipPnl` / `ShipPnlApiRow` not exported.

- [ ] **Step 3: Add the view-model + adapter**

In `app/components/dashboard/view-models.ts` add:

```ts
export interface ShipPnlRow {
  sku: string;
  title: string;
  shipping_collected_cents: number;
  ship_cost_cents: number;
  /** shipping_collected − ship_cost; negative = leaking on shipping. */
  net_shipping_pnl_cents: number;
  /** ship_cost_source for the provenance tag. */
  ship_cost_source: string;
}
```

In `app/lib/dashboard/client.ts`, import `ShipPnlRow` from view-models and add:

```ts
export interface ShipPnlApiRow {
  sku: string;
  title: string;
  shipping_collected_cents: number;
  ship_cost_cents: number;
  ship_cost_source: string;
}

/** Map per-SKU shipping P&L API rows → view-models, worst net first. */
export function adaptShipPnl(rows: ShipPnlApiRow[]): ShipPnlRow[] {
  return rows
    .map((r) => ({
      sku: r.sku,
      title: r.title,
      shipping_collected_cents: r.shipping_collected_cents,
      ship_cost_cents: r.ship_cost_cents,
      net_shipping_pnl_cents: r.shipping_collected_cents - r.ship_cost_cents,
      ship_cost_source: r.ship_cost_source,
    }))
    .sort((a, b) => a.net_shipping_pnl_cents - b.net_shipping_pnl_cents);
}
```

Extend `AnalyticsEnvelope` with `ship_pnl: ShipPnlApiRow[]` and have `fetchAnalytics` return `shipPnl: adaptShipPnl(data.ship_pnl ?? [])`. Update `fetchAnalytics`'s return type accordingly:

```ts
interface AnalyticsEnvelope {
  roas_series: DailyRoasRow[];
  grades: CampaignGradeRow[];
  top_ads: TopAdRow[];
  ship_pnl: ShipPnlApiRow[];
}

export async function fetchAnalytics(): Promise<{
  daily: DailyRow[];
  grades: CampaignGradeRow[];
  topAds: TopAd[];
  shipPnl: ShipPnlRow[];
}> {
  const data = await apiGet<AnalyticsEnvelope>("/dashboard/api/analytics");
  return {
    daily: adaptDaily(data.roas_series),
    grades: data.grades,
    topAds: data.top_ads.map((t) => ({ /* unchanged mapping */
      ad_name: t.ad_name,
      campaign_name: t.campaign_name,
      reactions: t.reactions,
      comments: t.comments,
      shares: t.shares,
      saves: t.saves,
      engagement: t.engagement,
    })),
    shipPnl: adaptShipPnl(data.ship_pnl ?? []),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/dashboard/__tests__/adapt-ship-pnl.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/components/dashboard/view-models.ts app/lib/dashboard/client.ts app/lib/dashboard/__tests__/adapt-ship-pnl.test.ts
git commit -m "dashboard/analytics: ShipPnlRow view-model + adaptShipPnl adapter"
```

---

## Task 12: Analytics server slice — read sku_pnl shipping P&L

**Files:**
- Modify: `app/lib/calderyn.server.ts` (`analytics.shipPnl()` method)
- Modify: `app/routes/dashboard.api.analytics.tsx` (include `ship_pnl` in the envelope)
- Test: `app/lib/__tests__/analytics-ship-pnl.test.ts`

- [ ] **Step 1: Write the failing test**

Create `app/lib/__tests__/analytics-ship-pnl.test.ts`. It fakes the supabase client the same way the existing `calderyn.server` tests do (search the repo for an existing `calderynClient` unit test to match the exact fake shape; the minimal contract is `from(table).select(...).eq(...)` resolving `{ data, error }`):

```ts
import { describe, it, expect, vi } from "vitest";

vi.mock("~/lib/supabase.server", () => {
  const rows = {
    sku_pnl: [
      { sku_id: "s1", ship_cost_cents: 6000, ship_cost_source: "reconciled" },
      { sku_id: "s2", ship_cost_cents: 1000, ship_cost_source: "modeled" },
    ],
    v_skus_flat: [
      { id: "s1", sku: "TEE-RED", title: "Red Tee" },
      { id: "s2", sku: "MUG", title: "Mug" },
    ],
    order_line_fact_shipping: [
      // shipping collected attributed per sku (sum of shipping_cents split by line)
      { sku_id: "s1", shipping_collected_cents: 0 },
      { sku_id: "s2", shipping_collected_cents: 500 },
    ],
  } as Record<string, Record<string, unknown>[]>;
  return {
    resolveShopId: async () => "shop-1",
    getSupabase: () => ({
      from: (t: string) => ({
        select: () => ({ eq: () => Promise.resolve({ data: rows[t] ?? [], error: null }) }),
      }),
    }),
  };
});

import { calderynClient } from "~/lib/calderyn.server";

describe("analytics.shipPnl", () => {
  it("returns per-SKU shipping collected, ship cost, and source", async () => {
    const client = calderynClient("x.myshopify.com");
    const rows = await client.analytics.shipPnl();
    const s1 = rows.find((r) => r.sku === "TEE-RED")!;
    expect(s1.ship_cost_cents).toBe(6000);
    expect(s1.ship_cost_source).toBe("reconciled");
    expect(s1.shipping_collected_cents).toBe(0);
  });
});
```

The exact source table/view for "shipping collected per SKU" depends on what Plan 1 left available. If `sku_pnl` already carries a shipping-collected column, read it directly; otherwise compute it from `order_line_fact` + `order_fact.shipping_cents` split, OR expose a `v_sku_ship_pnl` view in the same place Plan 1 added its margin view. **Resolve this lookup during implementation** (Step 3) and shape the test's faked tables to match the chosen source. The binding contract is the returned shape: `{ sku, title, shipping_collected_cents, ship_cost_cents, ship_cost_source }`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/__tests__/analytics-ship-pnl.test.ts`
Expected: FAIL — `analytics.shipPnl` is not a function.

- [ ] **Step 3: Implement the slice**

In `app/lib/calderyn.server.ts`, add a `ShipPnlServerRow` type near the analytics types and a `shipPnl()` method inside the `analytics:` object. Read `sku_pnl` (per-SKU `ship_cost_cents`, dominant `ship_cost_source`), join `v_skus_flat` for `sku`/`title`, and the shipping-collected aggregate source resolved in Step 1. Aggregate per SKU; coalesce missing numbers to 0. Return `ShipPnlServerRow[]`:

```ts
// type (near DailyRoasRow etc. in types.ts, or local):
export interface ShipPnlServerRow {
  sku: string;
  title: string;
  shipping_collected_cents: number;
  ship_cost_cents: number;
  ship_cost_source: string;
}
```

Method (inside `analytics:`), following the `campaignGrades` read/aggregate idiom already in the file (Promise.all the reads, build a Map keyed by sku_id, coalesce, surface read errors via `rethrow("analytics.shipPnl", err)`):

```ts
      async shipPnl(_signal?: AbortSignal): Promise<ShipPnlServerRow[]> {
        try {
          const shopId = await shopIdP;
          const [pnlRes, skuRes, shipRes] = await Promise.all([
            supabase.from("sku_pnl").select("sku_id, ship_cost_cents, ship_cost_source").eq("shop_id", shopId),
            supabase.from("v_skus_flat").select("id, sku, title").eq("shop_id", shopId),
            // shipping collected per SKU — source resolved in Step 1 (view or computed).
            supabase.from("v_sku_ship_pnl").select("sku_id, shipping_collected_cents").eq("shop_id", shopId),
          ]);
          if (pnlRes.error) throw pnlRes.error;
          if (skuRes.error) throw skuRes.error;
          if (shipRes.error) throw shipRes.error;

          const skuMeta = new Map<string, { sku: string; title: string }>();
          for (const r of skuRes.data ?? []) skuMeta.set(String(r.id), { sku: String(r.sku ?? ""), title: String(r.title ?? "") });
          const collected = new Map<string, number>();
          for (const r of shipRes.data ?? []) collected.set(String(r.sku_id), Number(r.shipping_collected_cents ?? 0));

          const out: ShipPnlServerRow[] = [];
          const seen = new Set<string>();
          for (const r of pnlRes.data ?? []) {
            const id = String(r.sku_id);
            if (seen.has(id)) continue;
            seen.add(id);
            const meta = skuMeta.get(id);
            out.push({
              sku: meta?.sku ?? id,
              title: meta?.title ?? "",
              shipping_collected_cents: collected.get(id) ?? 0,
              ship_cost_cents: Number(r.ship_cost_cents ?? 0),
              ship_cost_source: String(r.ship_cost_source ?? "modeled"),
            });
          }
          return out;
        } catch (err) {
          rethrow("analytics.shipPnl", err);
        }
      },
```

If `v_sku_ship_pnl` does not exist after Plan 1, either add it in a small migration alongside this task (security_invoker, per `20260604140000_views_security_invoker.sql`) or compute collected per SKU from `order_line_fact`/`order_fact` here. Match the test's faked tables to whichever you choose.

Then in `app/routes/dashboard.api.analytics.tsx`, add `client.analytics.shipPnl()` to the `Promise.all` and include `ship_pnl: shipPnl` in the returned envelope:

```ts
    const [roasSeries, grades, topAds, shipPnl] = await Promise.all([
      client.analytics.dailyRoasSeries(30),
      client.analytics.campaignGrades(),
      client.analytics.topAdsByEngagement(30, 10),
      client.analytics.shipPnl(),
    ]);
    return { roas_series: roasSeries, grades, top_ads: topAds, ship_pnl: shipPnl };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/__tests__/analytics-ship-pnl.test.ts`
Expected: PASS.

- [ ] **Step 5: Update the analytics route test for the new envelope key**

The existing `app/lib/dashboard/__tests__/api-analytics-route.test.ts` mocks `calderynClient().analytics` — add `shipPnl: (...a) => shipPnl(...a)` to its mock and a `const shipPnl = vi.fn()` with `shipPnl.mockResolvedValue([])` in `beforeEach`, and assert the envelope includes `ship_pnl`. Run:

Run: `npx vitest run app/lib/dashboard/__tests__/api-analytics-route.test.ts`
Expected: PASS (after the mock gains `shipPnl`).

- [ ] **Step 6: Commit**

```bash
git add app/lib/calderyn.server.ts app/lib/types.ts app/routes/dashboard.api.analytics.tsx app/lib/__tests__/analytics-ship-pnl.test.ts app/lib/dashboard/__tests__/api-analytics-route.test.ts
git commit -m "dashboard/analytics: shipPnl server slice (per-SKU net shipping + provenance)"
```

---

## Task 13: Render the ship-P&L section in the Analytics screen

**Files:**
- Modify: `app/components/dashboard/screens/Analytics.tsx`
- Test: `app/components/dashboard/screens/__tests__/analytics-ship-pnl.test.tsx`

This is presentational. Add a "Shipping P&L" section listing the worst-net SKUs with a `ProvenanceTag`. Test the pure row-formatting via a small exported helper so we avoid a full render harness (the repo's screen tests favor pure helpers — see `dashboard-stat-row.test.ts`).

- [ ] **Step 1: Write the failing test**

Create `app/components/dashboard/screens/__tests__/analytics-ship-pnl.test.tsx`:

```ts
import { describe, it, expect } from "vitest";
import { shipPnlRowLabel } from "../Analytics";
import type { ShipPnlRow } from "../../view-models";

const row: ShipPnlRow = {
  sku: "TEE-RED",
  title: "Red Tee",
  shipping_collected_cents: 0,
  ship_cost_cents: 6000,
  net_shipping_pnl_cents: -6000,
  ship_cost_source: "reconciled",
};

describe("shipPnlRowLabel", () => {
  it("formats a leaking row as a negative money value with the SKU title", () => {
    const l = shipPnlRowLabel(row);
    expect(l.title).toBe("Red Tee");
    expect(l.net).toMatch(/-\$60/);
    expect(l.leaking).toBe(true);
    expect(l.source).toBe("reconciled");
  });
  it("marks a positive net as not leaking", () => {
    const l = shipPnlRowLabel({ ...row, shipping_collected_cents: 7000, net_shipping_pnl_cents: 1000 });
    expect(l.leaking).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/components/dashboard/screens/__tests__/analytics-ship-pnl.test.tsx`
Expected: FAIL — `shipPnlRowLabel` not exported.

- [ ] **Step 3: Implement the helper + section**

In `app/components/dashboard/screens/Analytics.tsx`:

Add imports at top (extend existing ones):
```ts
import { ProvenanceTag } from "../ui";
import { CDIcon } from "../icons";
import type { DailyRow, TopAd, ShipPnlRow } from "../view-models";
import { money } from "../format";
```

Add the exported pure helper (above the component):
```ts
export function shipPnlRowLabel(r: ShipPnlRow): {
  title: string;
  net: string;
  leaking: boolean;
  source: string;
} {
  return {
    title: r.title || r.sku,
    net: money(r.net_shipping_pnl_cents),
    leaking: r.net_shipping_pnl_cents < 0,
    source: r.ship_cost_source,
  };
}
```

Extend `AnalyticsData` with `shipPnl: ShipPnlRow[]` and the `fetchAnalytics()` consumer (`setData(res)` already carries it through since `fetchAnalytics` now returns `shipPnl`). Add `const shipPnl = data?.shipPnl ?? [];` near the other derived lists, and render a section in the `cd-grid-main` area (alongside Campaign grades / Most-engaging ads):

```tsx
        <section className="min-w-0">
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="cd-h2 flex items-center gap-2">
              <CDIcon name="truck" size={16} /> Shipping P&amp;L
            </h2>
          </div>
          <Card pad={false}>
            {shipPnl.length === 0 ? (
              <Placeholder
                icon="truck"
                title="No shipping data yet"
                sub="Net shipping P&L appears once orders carry a resolved ship cost."
              />
            ) : (
              <div className="cd-rows">
                {shipPnl.slice(0, 10).map((r) => {
                  const l = shipPnlRowLabel(r);
                  return (
                    <div key={r.sku} className="cd-row" style={{ cursor: "default" }}>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="cd-row-title truncate">{l.title}</span>
                          <ProvenanceTag source={l.source} />
                        </div>
                        <div className="cd-caption truncate">
                          {money(r.shipping_collected_cents)} collected ·{" "}
                          {money(r.ship_cost_cents)} carrier cost
                        </div>
                      </div>
                      <div
                        className="cd-row-num tabular-nums"
                        style={{ color: l.leaking ? "var(--red)" : "var(--green)" }}
                      >
                        {l.net}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
          <p className="cd-caption mt-2">
            Net shipping P&amp;L = what customers paid for shipping minus what you paid carriers.
          </p>
        </section>
```

(If `Placeholder`'s `icon` prop is a constrained union not including `"truck"`, use an existing allowed icon name there; the new `truck` registry entry is for the `CDIcon` header.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/components/dashboard/screens/__tests__/analytics-ship-pnl.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/components/dashboard/screens/Analytics.tsx app/components/dashboard/screens/__tests__/analytics-ship-pnl.test.tsx
git commit -m "dashboard/Analytics: shipping P&L section with provenance tag"
```

---

## Task 14: Dashboard Alerts detail — wire the two free-ship action buttons

**Files:**
- Modify: `app/components/dashboard/context.ts` (extend `ActionKind` used by the dashboard ctx if it is a local union; otherwise no-op)
- Modify: `app/components/dashboard/DashboardApp.tsx` (or wherever `executeAction` maps an `ActionKind` to a fetch — route the two new kinds to `executeAlertAction`)
- Test: `app/components/dashboard/__tests__/execute-free-ship-action.test.ts`

- [ ] **Step 1: Find where `executeAction` dispatches by kind**

Run: `git grep -n "executeAlertAction\|executeCampaignAction\|executeAction" app/components/dashboard`
The dashboard shell's `executeAction(alert, kind)` chooses an endpoint by kind. Inventory/snooze go to `executeAlertAction` (the `/dashboard/api/alerts/:id/action` route). Read that mapping.

- [ ] **Step 2: Write the failing test**

Create `app/components/dashboard/__tests__/execute-free-ship-action.test.ts`. It tests the pure kind→endpoint routing helper. If the shell does the routing inline, extract a small exported helper `alertActionEndpointKind(kind)` first (returns `"alert" | "campaign" | null`), then test it:

```ts
import { describe, it, expect } from "vitest";
import { alertActionEndpointKind } from "../DashboardApp";

describe("alertActionEndpointKind", () => {
  it("routes free-ship kinds to the alert-action endpoint", () => {
    expect(alertActionEndpointKind("raise_free_ship_threshold")).toBe("alert");
    expect(alertActionEndpointKind("exclude_sku_free_ship")).toBe("alert");
  });
  it("routes inventory + snooze to the alert endpoint", () => {
    expect(alertActionEndpointKind("reallocate_inventory")).toBe("alert");
    expect(alertActionEndpointKind("snooze_alert")).toBe("alert");
  });
  it("routes campaign kinds to the campaign endpoint", () => {
    expect(alertActionEndpointKind("pause_campaign")).toBe("campaign");
    expect(alertActionEndpointKind("reduce_campaign_budget")).toBe("campaign");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run app/components/dashboard/__tests__/execute-free-ship-action.test.ts`
Expected: FAIL — `alertActionEndpointKind` not exported (and/or returns wrong value for the free-ship kinds).

- [ ] **Step 4: Implement the routing helper**

In `app/components/dashboard/DashboardApp.tsx`, add an exported helper and use it inside `executeAction`:

```ts
export function alertActionEndpointKind(kind: string): "alert" | "campaign" | null {
  if (kind === "pause_campaign" || kind === "reduce_campaign_budget" || kind === "reallocate_budget") {
    return "campaign";
  }
  if (
    kind === "reallocate_inventory" ||
    kind === "snooze_alert" ||
    kind === "raise_free_ship_threshold" ||
    kind === "exclude_sku_free_ship"
  ) {
    return "alert";
  }
  return null;
}
```

Refactor `executeAction` so it calls `alertActionEndpointKind(kind)` and dispatches to `executeAlertAction(alert.id, { type: kind })` for `"alert"`, `executeCampaignAction(...)` for `"campaign"` (preserving the existing campaign-id resolution), and surfaces a toast for `null`. Keep the existing optimistic-state / error-toast behavior untouched.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run app/components/dashboard/__tests__/execute-free-ship-action.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/components/dashboard/DashboardApp.tsx app/components/dashboard/__tests__/execute-free-ship-action.test.ts
git commit -m "dashboard/shell: route free-ship action kinds to the alert-action endpoint"
```

---

## Final verification (pre-commit gate)

- [ ] `npm run typecheck` → exit 0 (the `Record<DetectorId,…>`/`Record<ActionKind,…>` exhaustiveness across `labels.ts`, `client.ts` `AUDIT_VERBS`, and `tools.server.ts` is the safety net — any missed map fails here).
- [ ] `npm run lint` → exit 0 (`--max-warnings=0` on touched files).
- [ ] `npm run build` → exit 0 (Remix + Vite build completes).
- [ ] `npx vitest run app/lib/ship-cost app/lib/actions app/lib/assistant app/lib/dashboard app/components/dashboard app/routes/__tests__` → all green.
- [ ] No `prisma/schema.prisma` change in this part (no `npx prisma validate` needed). If Task 12 adds a `v_sku_ship_pnl` migration, run `npx prisma migrate diff --exit-code` and apply it to a Supabase dev branch before merge.
- [ ] No `.graphql`/Admin-query change (no `graphql-codegen` needed).

## Self-review

**Spec coverage**
- Detector logic + confidence gate → Tasks 3 (pure core) + 4 (I/O wrapper) + 5 (wiring). ✔
- Alert row contract (entity_ref, dollar_impact in dollars, evidence keys, idempotent upsert on `shop_id,detector_id,entity_ref`) → Task 4. ✔
- propose_action payloads + two actions → Tasks 1, 2, 6 (enum), 7 (executor payloads + undo-friendly). ✔
- Dashboard parity (a) ship-cost/net-shipping-P&L column with provenance → Tasks 10–13; (b) leakage alert in dashboard alerts surface → Tasks 9, 14 (renders generically via `detector_id`); (c) provenance tag visible → Tasks 10 (ProvenanceTag), 13 (Analytics), 2 (`ship_cost_confidence` evidence label shows on alert detail). ✔
- Embedded-admin minimal (point 4) → confirmed in spec; only label/registry additions (Tasks 1–2), no bespoke Polaris component. ✔
- Success criteria (no-fire below the bar; idempotent re-run; severity by magnitude; undo re-opens alert) → Tasks 3, 4, 7. ✔
- Deferrals (3 other alerts; real Shopify mutation; Settings tunables) → named in spec "Out of scope". ✔

**Placeholder scan** — every code step contains complete code. Two unavoidable implementation-time lookups are flagged explicitly with a binding contract the engineer resolves against (rule: surface, don't hide): the engine-run handler's exact name/shape (Task 5 Step 1 instructs locating it) and the shipping-collected-per-SKU source (Task 12 Step 1/3, with the return shape fixed as the contract). These are "find the existing seam," not "decide the behavior."

**Type/name consistency vs frozen contract** — `ship_cost_cents`, `ship_cost_source`, `ship_cost_confidence`, `shipping_cents`, `customer_country` consumed exactly as Plan 1 froze them; `classifyZone`/`splitOrderShipCost` imported, not redefined; `ShipCostConfidence` imported from `app/lib/ship-cost/types.ts` (Plan 1). New names introduced once and reused: `detector_id` string `"free_shipping_leakage"`, `ActionKind`s `raise_free_ship_threshold`/`exclude_sku_free_ship`, `LeakCluster`, `ShipLeakOrder`, `ShipPnlRow`/`ShipPnlApiRow`/`ShipPnlServerRow`, `provenanceLabel`/`ProvenanceTag`, `alertActionEndpointKind`, `runFreeShipLeakageDetect`, `executeFreeShipAlertAction`. `dollar_impact` stored in **dollars** in the alert row (Task 4) consistent with `rowToAlert`'s `*100` read boundary in `calderyn.server.ts`. Upsert `onConflict` matches the live `alerts_active_condition_key` index columns.

**Dashboard parity actually covered** — re-implemented against the dashboard's own primitives (Card/Pill/Placeholder/CDIcon/Lucide), not ported from Polaris; the alert renders through the existing data-driven dashboard Alerts screen; analytics gets a real new slice end-to-end (server method → route envelope → client adapter → screen section). ✔
