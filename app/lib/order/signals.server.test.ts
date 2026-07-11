import { describe, it, expect, beforeEach, vi } from "vitest";

// Minimal in-memory stand-in for the two tables buyerOrderSignals touches (`orders` +
// `transaction_ledger`), tracking from() call counts per table so the fold-not-subquery shape
// (ONE query per table, never a per-row correlated read) is assertable, not just assumed.
const store = vi.hoisted(() => {
  type Row = Record<string, any>;
  const db: Record<string, Row[]> = { orders: [], transaction_ledger: [] };
  const fromCalls: Record<string, number> = { orders: 0, transaction_ledger: 0 };

  class Builder {
    private filters: Array<[string, unknown]> = [];
    private inFilters: Array<[string, unknown[]]> = [];
    private rangeBounds: [number, number] | null = null;
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
    order(_col: string, _opts?: unknown) {
      return this;
    }
    range(from: number, to: number) {
      this.rangeBounds = [from, to];
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
    private run() {
      let rows = db[this.table].filter((r) => this.matches(r));
      // Mirror PostgREST's inclusive .range() so the source's page loop terminates after one call
      // for small fixtures (batch < page size) while still exercising the paged read path.
      if (this.rangeBounds) rows = rows.slice(this.rangeBounds[0], this.rangeBounds[1] + 1);
      return { data: rows, error: null };
    }
  }

  const client = {
    from: (table: string) => {
      fromCalls[table] = (fromCalls[table] ?? 0) + 1;
      return new Builder(table);
    },
  };
  return { db, client, fromCalls };
});

vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => store.client }));

// eslint-disable-next-line import/first -- imports must follow vi.mock so the fake registers first
import { buyerOrderSignals } from "./signals.server";

const SHOP = "shop-1";

beforeEach(() => {
  store.db.orders.length = 0;
  store.db.transaction_ledger.length = 0;
  store.fromCalls.orders = 0;
  store.fromCalls.transaction_ledger = 0;
});

function pushOrder(id: string, state: string, channel = "storefront") {
  store.db.orders.push({ id, shop_id: SHOP, buyer_id: "buyer-1", state, channel });
}

function pushLedger(orderRef: string, kind: "capture" | "refund", amountCents: number) {
  store.db.transaction_ledger.push({ shop_id: SHOP, order_ref: orderRef, kind, amount_cents: amountCents });
}

describe("buyerOrderSignals — guest buyer", () => {
  it("returns the all-quiet shape and issues zero queries for a null buyerId", async () => {
    const result = await buyerOrderSignals(SHOP, null);
    expect(result).toEqual({ repeatCustomer: false, buyerOrderCount: 0, refundRisk: false });
    expect(store.fromCalls.orders).toBe(0);
    expect(store.fromCalls.transaction_ledger).toBe(0);
  });
});

describe("buyerOrderSignals — fold-not-subquery shape", () => {
  it("issues exactly ONE query against orders and ONE against transaction_ledger, regardless of row count", async () => {
    pushOrder("o1", "paid");
    pushOrder("o2", "fulfilled");
    pushOrder("o3", "refunded");
    pushLedger("o1", "capture", 1000);
    pushLedger("o2", "capture", 2000);
    pushLedger("o3", "capture", 3000);
    pushLedger("o3", "refund", -500);

    await buyerOrderSignals(SHOP, "buyer-1");

    expect(store.fromCalls.orders).toBe(1);
    expect(store.fromCalls.transaction_ledger).toBe(1);
  });

  it("skips the transaction_ledger query entirely when the buyer has zero counted orders", async () => {
    pushOrder("o1", "cart"); // not a purchase state — filtered out before the ledger read
    const result = await buyerOrderSignals(SHOP, "buyer-1");
    expect(result).toEqual({ repeatCustomer: false, buyerOrderCount: 0, refundRisk: false });
    expect(store.fromCalls.orders).toBe(1);
    expect(store.fromCalls.transaction_ledger).toBe(0);
  });
});

describe("buyerOrderSignals — repeatCustomer threshold (exact 2 orders)", () => {
  it("false for a single-order buyer", async () => {
    pushOrder("o1", "paid");
    pushLedger("o1", "capture", 5000);
    const result = await buyerOrderSignals(SHOP, "buyer-1");
    expect(result.buyerOrderCount).toBe(1);
    expect(result.repeatCustomer).toBe(false);
  });

  it("true at exactly 2 purchase-state orders", async () => {
    pushOrder("o1", "paid");
    pushOrder("o2", "fulfilled");
    pushLedger("o1", "capture", 5000);
    pushLedger("o2", "capture", 5000);
    const result = await buyerOrderSignals(SHOP, "buyer-1");
    expect(result.buyerOrderCount).toBe(2);
    expect(result.repeatCustomer).toBe(true);
  });

  it("counts partially_refunded as a purchase state, mirroring the buyer directory's Repeat segment", async () => {
    pushOrder("o1", "paid");
    pushOrder("o2", "partially_refunded");
    const result = await buyerOrderSignals(SHOP, "buyer-1");
    expect(result.buyerOrderCount).toBe(2);
    expect(result.repeatCustomer).toBe(true);
  });

  it("excludes non-purchase states (cart, checkout_pending, cancelled) from the order count", async () => {
    pushOrder("o1", "paid");
    pushOrder("o2", "cart");
    pushOrder("o3", "checkout_pending");
    pushOrder("o4", "cancelled");
    const result = await buyerOrderSignals(SHOP, "buyer-1");
    expect(result.buyerOrderCount).toBe(1);
    expect(result.repeatCustomer).toBe(false);
  });

  it("excludes channel='test' go-live probe orders from the count, even in a purchase state", async () => {
    pushOrder("o1", "paid");
    pushOrder("o2", "paid", "test");
    const result = await buyerOrderSignals(SHOP, "buyer-1");
    expect(result.buyerOrderCount).toBe(1);
    expect(result.repeatCustomer).toBe(false);
  });
});

describe("buyerOrderSignals — refundRisk (cents-based ratio, exact 30% boundary)", () => {
  it("false at exactly a 30% refund ratio (strict > required)", async () => {
    pushOrder("o1", "paid");
    pushOrder("o2", "refunded");
    pushLedger("o1", "capture", 5000);
    pushLedger("o2", "capture", 5000);
    pushLedger("o2", "refund", -3000); // 3000 / 10000 = exactly 30%
    const result = await buyerOrderSignals(SHOP, "buyer-1");
    expect(result.refundRisk).toBe(false);
  });

  it("true just past the 30% refund ratio", async () => {
    pushOrder("o1", "paid");
    pushOrder("o2", "refunded");
    pushLedger("o1", "capture", 5000);
    pushLedger("o2", "capture", 5000);
    pushLedger("o2", "refund", -3001); // 3001 / 10000 = 30.01%
    const result = await buyerOrderSignals(SHOP, "buyer-1");
    expect(result.refundRisk).toBe(true);
  });

  it("false for a high refund ratio when the buyer has only 1 order (the 2-order gate wins)", async () => {
    pushOrder("o1", "paid");
    pushLedger("o1", "capture", 5000);
    pushLedger("o1", "refund", -5000); // 100% refunded, but only one order
    const result = await buyerOrderSignals(SHOP, "buyer-1");
    expect(result.buyerOrderCount).toBe(1);
    expect(result.refundRisk).toBe(false);
  });

  it("uses refund-cents magnitude summed across the buyer's orders, not an order-count ratio", async () => {
    // Two orders; one fully refunded, one untouched — 1-of-2 orders refunded (50% by count) would
    // read as risk under an order-count ratio, but the cents ratio here is 5000/15000 = 33%, still
    // over 30%, so this case happens to agree — the point is the MATH is cents-based, verified by
    // the exact-30%-boundary case above landing on false where an order-count ratio (1/2 = 50%)
    // would have tripped true.
    pushOrder("o1", "paid");
    pushOrder("o2", "refunded");
    pushLedger("o1", "capture", 10000);
    pushLedger("o2", "capture", 5000);
    pushLedger("o2", "refund", -5000);
    const result = await buyerOrderSignals(SHOP, "buyer-1");
    expect(result.refundRisk).toBe(true);
  });

  it("never divides by zero when the buyer has orders but zero captures", async () => {
    pushOrder("o1", "paid");
    pushOrder("o2", "fulfilled");
    // No transaction_ledger rows at all for either order.
    const result = await buyerOrderSignals(SHOP, "buyer-1");
    expect(result.refundRisk).toBe(false);
    expect(result.repeatCustomer).toBe(true);
  });
});
