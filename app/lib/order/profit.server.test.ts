import { describe, it, expect, beforeEach, vi } from "vitest";

// Canonical in-memory Builder pattern (detail.server.test.ts / line-edits.server.test.ts),
// extended with nothing new — orderProfit's reads only need .select/.eq/.in/.maybeSingle.
const store = vi.hoisted(() => {
  type Row = Record<string, any>;
  const db: Record<string, Row[]> = {
    orders: [],
    order_line: [],
    order_line_edit: [],
    transaction_ledger: [],
    order_fact: [],
    shipping_invoice_line: [],
    imported_order: [],
    imported_order_line: [],
    imported_refund: [],
  };

  class Builder {
    private filters: Array<[string, unknown]> = [];
    private inFilters: Array<[string, unknown[]]> = [];
    private wantSingle = false;
    private readonly table: string;
    constructor(table: string) {
      this.table = table;
    }
    select(_cols?: string) {
      return this;
    }
    eq(col: string, val: unknown) {
      this.filters.push([col, val]);
      return this;
    }
    in(col: string, vals: unknown[]) {
      this.inFilters.push([col, vals]);
      return this;
    }
    maybeSingle() {
      this.wantSingle = true;
      return this;
    }
    then(resolve: (v: { data: unknown; error: unknown }) => unknown, reject?: (e: unknown) => unknown) {
      return Promise.resolve(this.run()).then(resolve, reject);
    }
    private matches(row: Row): boolean {
      const eqOk = this.filters.every(([c, v]) => row[c] === v);
      const inOk = this.inFilters.every(([c, vals]) => vals.includes(row[c]));
      return eqOk && inOk;
    }
    private run(): { data: unknown; error: unknown } {
      const t = db[this.table];
      const matched = t.filter((r) => this.matches(r));
      return { data: this.wantSingle ? (matched[0] ?? null) : matched, error: null };
    }
  }

  const client = { from: (table: string) => new Builder(table) };
  return { db, client };
});

vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => store.client }));

// eslint-disable-next-line import/first -- imports must follow vi.mock so the fake registers first
import { orderProfit } from "./profit.server";

beforeEach(() => {
  for (const k of Object.keys(store.db)) store.db[k].length = 0;
});

const SHOP = "shop-1";

function pushCapture(orderId: string, amountCents: number, ref = orderId) {
  store.db.transaction_ledger.push({ shop_id: SHOP, order_ref: ref, kind: "capture", amount_cents: amountCents });
}

describe("orderProfit — native orders", () => {
  it("full data: revenue, COGS, carrier cost and fees all compute cleanly", async () => {
    store.db.orders.push({ id: "order-1", shop_id: SHOP, total_cents: 10000, attribution: { channel: "meta" } });
    store.db.order_line.push(
      { id: "line-1", shop_id: SHOP, order_id: "order-1", quantity: 2, unit_cost_cents_snapshot: 2000 },
      { id: "line-2", shop_id: SHOP, order_id: "order-1", quantity: 1, unit_cost_cents_snapshot: 1000 },
    );
    pushCapture("order-1", 10000);
    store.db.order_fact.push({ id: "fact-1", shop_id: SHOP, order_number: "order-1", external_id: "gid://calderyn/Order/order-1" });
    store.db.shipping_invoice_line.push(
      { shop_id: SHOP, matched_order_id: "fact-1", cost_cents: 300 },
      { shop_id: SHOP, matched_order_id: "fact-1", cost_cents: 200 },
    );

    const p = await orderProfit(SHOP, "order-1");
    expect(p).not.toBeNull();
    // COGS = 2*2000 + 1*1000 = 5000
    expect(p!.cogsCents).toBe(5000);
    expect(p!.costsMissing).toBe(0);
    // Carrier cost = 300 + 200 = 500
    expect(p!.carrierCostCents).toBe(500);
    // revenue = 10000 (no refunds)
    expect(p!.revenueCents).toBe(10000);
    // fees = round(10000 * 0.029) + 1*30 = 290 + 30 = 320
    expect(p!.feeEstimateCents).toBe(320);
    // profit = 10000 - 5000 - 500 - 320 = 4180
    expect(p!.profitCents).toBe(4180);
    expect(p!.marginPct).toBeCloseTo(41.8, 5);
    expect(p!.estimated).toBe(true);
    expect(p!.attributionLabel).toBe("meta");
    expect(p!.source).toBe("calderyn");
  });

  it("missing cost snapshots: excluded from COGS and counted, not fabricated as 0", async () => {
    store.db.orders.push({ id: "order-2", shop_id: SHOP, total_cents: 5000, attribution: null });
    store.db.order_line.push(
      { id: "line-1", shop_id: SHOP, order_id: "order-2", quantity: 2, unit_cost_cents_snapshot: 1000 },
      { id: "line-2", shop_id: SHOP, order_id: "order-2", quantity: 1, unit_cost_cents_snapshot: null },
    );
    pushCapture("order-2", 5000);

    const p = await orderProfit(SHOP, "order-2");
    expect(p!.cogsCents).toBe(2000); // only line-1 counted
    expect(p!.costsMissing).toBe(1);
    expect(p!.carrierCostCents).toBeNull(); // no order_fact row at all
  });

  it("refunds are netted out of revenue via the ledger read", async () => {
    store.db.orders.push({ id: "order-3", shop_id: SHOP, total_cents: 8000, attribution: null });
    store.db.order_line.push({ id: "line-1", shop_id: SHOP, order_id: "order-3", quantity: 1, unit_cost_cents_snapshot: 1000 });
    pushCapture("order-3", 8000);
    store.db.transaction_ledger.push({ shop_id: SHOP, order_ref: "order-3", kind: "refund", amount_cents: -3000 });

    const p = await orderProfit(SHOP, "order-3");
    expect(p!.revenueCents).toBe(5000); // 8000 - 3000
  });

  it("no matching order_fact row at all: carrier cost is null, not 0", async () => {
    store.db.orders.push({ id: "order-4", shop_id: SHOP, total_cents: 1000, attribution: null });
    pushCapture("order-4", 1000);

    const p = await orderProfit(SHOP, "order-4");
    expect(p!.carrierCostCents).toBeNull();
  });

  it("order_fact exists but zero matched shipping_invoice_line rows: still null, not 0", async () => {
    store.db.orders.push({ id: "order-5", shop_id: SHOP, total_cents: 1000, attribution: null });
    pushCapture("order-5", 1000);
    store.db.order_fact.push({ id: "fact-5", shop_id: SHOP, order_number: "order-5" });

    const p = await orderProfit(SHOP, "order-5");
    expect(p!.carrierCostCents).toBeNull();
  });

  it("a real recorded carrier cost of exactly 0 stays 0, distinct from null", async () => {
    store.db.orders.push({ id: "order-6", shop_id: SHOP, total_cents: 1000, attribution: null });
    pushCapture("order-6", 1000);
    store.db.order_fact.push({ id: "fact-6", shop_id: SHOP, order_number: "order-6" });
    store.db.shipping_invoice_line.push({ shop_id: SHOP, matched_order_id: "fact-6", cost_cents: 0 });

    const p = await orderProfit(SHOP, "order-6");
    expect(p!.carrierCostCents).toBe(0);
  });

  it("fee floor: multi-capture invoice order charges 30 cents per capture, not once", async () => {
    store.db.orders.push({ id: "order-7", shop_id: SHOP, total_cents: 10000, attribution: null });
    // Two live-session captures on the same order (post-#400 multi-capture invoice scenario).
    pushCapture("order-7", 6000);
    pushCapture("order-7", 4000);

    const p = await orderProfit(SHOP, "order-7");
    // captured revenue = 6000 + 4000 = 10000; fee = round(10000*0.029) + 2*30 = 290 + 60 = 350
    expect(p!.feeEstimateCents).toBe(350);
  });

  it("zero capture rows falls back to ONE assumed capture at the order total (never a $0 fee)", async () => {
    store.db.orders.push({ id: "order-8", shop_id: SHOP, total_cents: 2000, attribution: null });
    // No transaction_ledger rows at all for this order.

    const p = await orderProfit(SHOP, "order-8");
    // fee = round(2000*0.029) + 1*30 = 58 + 30 = 88
    expect(p!.feeEstimateCents).toBe(88);
  });

  it("margin is null only when revenue is 0", async () => {
    store.db.orders.push({ id: "order-9", shop_id: SHOP, total_cents: 500, attribution: null });
    pushCapture("order-9", 500);
    store.db.transaction_ledger.push({ shop_id: SHOP, order_ref: "order-9", kind: "refund", amount_cents: -500 });

    const p = await orderProfit(SHOP, "order-9");
    expect(p!.revenueCents).toBe(0);
    expect(p!.marginPct).toBeNull();
    // profit still computes (never null) from the available components.
    expect(typeof p!.profitCents).toBe("number");
  });

  it("returns do not reduce COGS in v1 — closed return leaves effectiveLineQuantities unchanged", async () => {
    // Order with one line: 5 units @ 1000 cents COGS, total 5000 cents.
    store.db.orders.push({ id: "order-returns", shop_id: SHOP, total_cents: 5000, attribution: null });
    store.db.order_line.push({ id: "line-1", shop_id: SHOP, order_id: "order-returns", quantity: 5, unit_cost_cents_snapshot: 1000 });
    pushCapture("order-returns", 5000);

    const beforeReturn = await orderProfit(SHOP, "order-returns");
    expect(beforeReturn!.cogsCents).toBe(5000); // 5 * 1000

    // Now simulate a closed return (order_return + line rows exist) — but no order_line_edit row
    // is ever written for a return, so effectiveLineQuantities is untouched.
    store.db.transaction_ledger.push({ shop_id: SHOP, order_ref: "order-returns", kind: "refund", amount_cents: -2000 });
    // (in real life there would be order_return + returned_line rows, but they don't affect the
    // effectiveLineQuantities computation, so we don't need to mock them for this regression test)

    const afterReturn = await orderProfit(SHOP, "order-returns");
    // COGS is unchanged because effectiveLineQuantities is still 5 units (no edit rows).
    expect(afterReturn!.cogsCents).toBe(5000);
    // Revenue IS reduced (refund captured in transaction_ledger).
    expect(afterReturn!.revenueCents).toBe(3000); // 5000 - 2000
  });

  it("prefix routing: calderyn: prefix and a bare uuid resolve the same native order", async () => {
    store.db.orders.push({ id: "order-10", shop_id: SHOP, total_cents: 1000, attribution: null });
    pushCapture("order-10", 1000);

    const bare = await orderProfit(SHOP, "order-10");
    const prefixed = await orderProfit(SHOP, "calderyn:order-10");
    expect(bare).not.toBeNull();
    expect(prefixed).toEqual(bare);
  });

  it("unknown order id returns null (caller 404s)", async () => {
    const p = await orderProfit(SHOP, "ghost");
    expect(p).toBeNull();
  });

  it("cross-tenant order id returns null", async () => {
    store.db.orders.push({ id: "order-11", shop_id: "other-shop", total_cents: 1000, attribution: null });
    const p = await orderProfit(SHOP, "order-11");
    expect(p).toBeNull();
  });
});

describe("orderProfit — imported (Shopify-paid, read-only) orders", () => {
  it("shopify: prefix routes to the imported branch, source is 'shopify', estimated stays true", async () => {
    store.db.imported_order.push({ id: "imp-1", shop_id: SHOP, external_id: "gid://shopify/Order/1", total_cents: 4000 });
    store.db.imported_order_line.push({ shop_id: SHOP, imported_order_id: "imp-1", quantity: 2, unit_cost_cents_snapshot: 500 });

    const p = await orderProfit(SHOP, "shopify:imp-1");
    expect(p).not.toBeNull();
    expect(p!.source).toBe("shopify");
    expect(p!.cogsCents).toBe(1000); // 2 * 500
    expect(p!.attributionLabel).toBeNull();
    // one-assumed-capture floor: fee = round(4000*0.029) + 30 = 116 + 30 = 146
    expect(p!.feeEstimateCents).toBe(146);
    expect(p!.estimated).toBe(true);
  });

  it("imported refunds net out of revenue via imported_refund", async () => {
    store.db.imported_order.push({ id: "imp-2", shop_id: SHOP, external_id: "gid://shopify/Order/2", total_cents: 9000 });
    store.db.imported_refund.push({ shop_id: SHOP, imported_order_id: "imp-2", subtotal_cents: 2000 });

    const p = await orderProfit(SHOP, "shopify:imp-2");
    expect(p!.revenueCents).toBe(7000);
  });

  it("missing cost snapshots on imported lines are excluded and counted, same discipline as native", async () => {
    store.db.imported_order.push({ id: "imp-3", shop_id: SHOP, external_id: "gid://shopify/Order/3", total_cents: 3000 });
    store.db.imported_order_line.push(
      { shop_id: SHOP, imported_order_id: "imp-3", quantity: 1, unit_cost_cents_snapshot: 800 },
      { shop_id: SHOP, imported_order_id: "imp-3", quantity: 1, unit_cost_cents_snapshot: null },
    );

    const p = await orderProfit(SHOP, "shopify:imp-3");
    expect(p!.cogsCents).toBe(800);
    expect(p!.costsMissing).toBe(1);
  });

  it("carrier cost matches an imported order's order_fact row via external_id", async () => {
    store.db.imported_order.push({ id: "imp-4", shop_id: SHOP, external_id: "gid://shopify/Order/4", total_cents: 3000 });
    store.db.order_fact.push({ id: "fact-4", shop_id: SHOP, order_number: "unrelated", external_id: "gid://shopify/Order/4" });
    store.db.shipping_invoice_line.push({ shop_id: SHOP, matched_order_id: "fact-4", cost_cents: 450 });

    const p = await orderProfit(SHOP, "shopify:imp-4");
    expect(p!.carrierCostCents).toBe(450);
  });

  it("empty shopify: id (malformed) returns null", async () => {
    const p = await orderProfit(SHOP, "shopify:");
    expect(p).toBeNull();
  });

  it("unknown imported id returns null", async () => {
    const p = await orderProfit(SHOP, "shopify:ghost");
    expect(p).toBeNull();
  });
});
