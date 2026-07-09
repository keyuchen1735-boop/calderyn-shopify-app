import { describe, it, expect, beforeEach, vi } from "vitest";

// In-memory stand-in for the OLTP tables placeAgenticOrder touches (buyer_dim upserted by #1,
// orders + order_line written here, variant_dim read by the oversell check). Mirrors the harness
// shape from checkout.server.test.ts so this suite exercises the SAME reserve-on-order-id
// contract as the human-checkout path, just for the agentic (ACP/MCP) origination flow.
const store = vi.hoisted(() => {
  type Row = Record<string, any>;
  const db: Record<string, Row[]> = {
    buyer_dim: [],
    orders: [],
    order_line: [],
    variant_dim: [],
  };

  class Builder {
    private op: "select" | "insert" | "update" | "upsert" = "select";
    private payload: Row | Row[] = {};
    private vals: Row = {};
    private conflict: string[] = [];
    private filters: Array<[string, unknown]> = [];
    private inFilters: Array<[string, unknown[]]> = [];
    private wantSingle = false;
    private readonly table: string;

    constructor(table: string) {
      this.table = table;
    }
    insert(payload: Row | Row[]) {
      this.op = "insert";
      this.payload = payload;
      return this;
    }
    upsert(payload: Row | Row[], opts?: { onConflict?: string }) {
      this.op = "upsert";
      this.payload = payload;
      this.conflict = opts?.onConflict ? opts.onConflict.split(",").map((c) => c.trim()) : [];
      return this;
    }
    update(vals: Row) {
      this.op = "update";
      this.vals = vals;
      return this;
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
    single() {
      this.wantSingle = true;
      return this;
    }
    maybeSingle() {
      this.wantSingle = true;
      return this;
    }
    then(resolve: (v: { data: unknown; error: unknown }) => unknown, reject?: (e: unknown) => unknown) {
      return Promise.resolve(this.run()).then(resolve, reject);
    }

    private wrap(rows: Row[]) {
      return { data: this.wantSingle ? rows[0] ?? null : rows, error: null };
    }
    private insertOne(p: Row): Row {
      const t = db[this.table];
      const row: Row = { id: `${this.table}-${t.length + 1}`, created_at: new Date().toISOString(), ...p };
      t.push(row);
      return row;
    }
    private run(): { data: unknown; error: unknown } {
      const t = db[this.table];
      if (this.op === "insert") {
        const rows = (Array.isArray(this.payload) ? this.payload : [this.payload]).map((p) => this.insertOne(p));
        return this.wrap(rows);
      }
      if (this.op === "upsert") {
        const rows = (Array.isArray(this.payload) ? this.payload : [this.payload]).map((p) => {
          const existing = this.conflict.length
            ? t.find((r) => this.conflict.every((c) => r[c] === p[c]))
            : undefined;
          if (existing) {
            Object.assign(existing, p);
            return existing;
          }
          return this.insertOne(p);
        });
        return this.wrap(rows);
      }
      const matches = (r: Row) =>
        this.filters.every(([c, v]) => r[c] === v) &&
        this.inFilters.every(([c, vals]) => vals.includes(r[c]));
      if (this.op === "update") {
        const matched = t.filter(matches);
        for (const r of matched) Object.assign(r, this.vals);
        return this.wrap(matched);
      }
      const matched = t.filter(matches);
      return this.wrap(matched);
    }
  }

  const client = { from: (table: string) => new Builder(table) };
  return { db, client };
});

const quoteStore = vi.hoisted(() => ({ getQuote: vi.fn() }));
// Oversell protection: placeAgenticOrder reserves TRACKED lines via the inventory engine before
// returning, cancels + releases on a stockout. The engine RPCs are unit-tested in the inventory
// suite; here we assert the WIRING (which lines get reserved, and the cancel+release+throw).
const engine = vi.hoisted(() => ({ reserveStock: vi.fn(), releaseReservation: vi.fn() }));
const orderMod = vi.hoisted(() => ({ transitionOrder: vi.fn() }));

vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => store.client }));
// checkout.server.ts (imported here only for the shared OutOfStockError class) drags in the
// real Stripe SDK + quote.server chain; stub both exactly like checkout.server.test.ts so the
// module graph loads without a live STRIPE_SECRET_KEY or shipping-engine dependency.
vi.mock("stripe", () => ({
  default: class {
    paymentIntents = { create: vi.fn() };
  },
}));
vi.mock("~/lib/commerce/quote.server", () => ({ quoteCart: vi.fn() }));
vi.mock("~/lib/commerce/quote-store.server", () => ({ getQuote: quoteStore.getQuote }));
vi.mock("~/lib/inventory/engine.server", () => ({
  reserveStock: engine.reserveStock,
  releaseReservation: engine.releaseReservation,
}));
vi.mock("~/lib/order/order.server", () => ({ transitionOrder: orderMod.transitionOrder }));

// eslint-disable-next-line import/first -- imports must follow vi.mock so the fakes register first
import { placeAgenticOrder, OutOfStockError } from "../order.server";

/** Seed a variant_dim row so the oversell read can classify a line as tracked/untracked. */
function seedVariant(shopId: string, variantId: string, inventoryTracked: boolean | null) {
  store.db.variant_dim.push({ id: variantId, shop_id: shopId, inventory_tracked: inventoryTracked });
}

function lockedQuote(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    quoteId: "quote-1",
    lines: [
      { variantId: "v-tracked", quantity: 2, unitPriceCents: 1000, currency: "usd", titleSnapshot: "Cotton Tee" },
      { variantId: "v-digital", quantity: 1, unitPriceCents: 500, currency: "usd", titleSnapshot: "Gift Card" },
    ],
    subtotalCents: 2500,
    shippingCents: 0,
    taxCents: 0,
    totalCents: 2500,
    currency: "usd",
    deliveryEarliest: null,
    deliveryLatest: null,
    lowConfidence: false,
    fallbackUsed: false,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  for (const k of Object.keys(store.db)) store.db[k].length = 0;
  vi.clearAllMocks();
  quoteStore.getQuote.mockResolvedValue(lockedQuote());
  seedVariant("shop-1", "v-tracked", true);
  seedVariant("shop-1", "v-digital", false);
  // Default: every reserve succeeds (stock available). The stockout test overrides this.
  engine.reserveStock.mockResolvedValue({ ok: true, allocation: [{ locationId: "loc-1", qty: 1 }] });
  engine.releaseReservation.mockResolvedValue(undefined);
  orderMod.transitionOrder.mockResolvedValue({ id: "t-1", toState: "cancelled" });
});

describe("placeAgenticOrder — oversell protection", () => {
  it("reserves the TRACKED line only, keyed on the new order id", async () => {
    const out = await placeAgenticOrder(
      "shop-1",
      "quote-1",
      { email: "buyer@example.com" },
      { protocol: "mcp", clientId: "client-1" },
    );

    expect(store.db.orders).toHaveLength(1);
    expect(store.db.order_line).toHaveLength(2);

    expect(engine.reserveStock).toHaveBeenCalledTimes(1);
    expect(engine.reserveStock).toHaveBeenCalledWith("shop-1", "v-tracked", 2, out.orderId, null);
    expect(engine.releaseReservation).not.toHaveBeenCalled();
    expect(orderMod.transitionOrder).not.toHaveBeenCalled();
  });

  it("cancels the order + releases holds + throws OutOfStockError on a stockout", async () => {
    engine.reserveStock.mockResolvedValueOnce({ ok: false, reason: "insufficient_stock" });

    await expect(
      placeAgenticOrder(
        "shop-1",
        "quote-1",
        { email: "buyer@example.com" },
        { protocol: "mcp", clientId: "client-1" },
      ),
    ).rejects.toBeInstanceOf(OutOfStockError);

    expect(store.db.orders).toHaveLength(1);
    const orderId = store.db.orders[0].id;
    expect(engine.releaseReservation).toHaveBeenCalledWith("shop-1", orderId);
    expect(orderMod.transitionOrder).toHaveBeenCalledWith("shop-1", orderId, "cancelled", "agentic:out_of_stock");
  });
});
