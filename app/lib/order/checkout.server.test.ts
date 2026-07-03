import { describe, it, expect, beforeEach, vi } from "vitest";

// In-memory stand-in for the OLTP tables createCheckout touches (cart_line read by priceCart,
// buyer_dim upserted by #1, orders + order_line written here, payment_intent written by the
// Stripe helper). Enforces the constraints the helpers rely on so behavior is tested against
// REAL rules, not bare mocks:
//   - buyer_dim UNIQUE (shop_id, email_normalized): upsert resolves the same email to one row.
//   - orders / order_line are shop-scoped; the order is BORN in 'checkout_pending'.
const store = vi.hoisted(() => {
  type Row = Record<string, any>;
  const db: Record<string, Row[]> = {
    // createCheckout flags the source cart consumed (state -> checkout_pending).
    cart: [],
    cart_line: [],
    buyer_dim: [],
    buyer_address: [],
    orders: [],
    order_line: [],
    payment_intent: [],
    // Empty = no connected payout account -> createPaymentIntent takes the
    // platform-charge path (the #11 routing decision is tested in connect.server.test.ts).
    stripe_connected_account: [],
  };

  class Builder {
    private op: "select" | "insert" | "update" | "upsert" = "select";
    private payload: Row | Row[] = {};
    private vals: Row = {};
    private conflict: string[] = [];
    private filters: Array<[string, unknown]> = [];
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
      if (this.op === "update") {
        const matched = t.filter((r) => this.filters.every(([c, v]) => r[c] === v));
        for (const r of matched) Object.assign(r, this.vals);
        return this.wrap(matched);
      }
      const matched = t.filter((r) => this.filters.every(([c, v]) => r[c] === v));
      return this.wrap(matched);
    }
  }

  const client = { from: (table: string) => new Builder(table) };
  return { db, client };
});

const stripe = vi.hoisted(() => ({ piCreate: vi.fn() }));
const quote = vi.hoisted(() => ({ quoteCart: vi.fn() }));

vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => store.client }));
vi.mock("stripe", () => ({
  default: class {
    paymentIntents = { create: stripe.piCreate };
  },
}));
vi.mock("~/lib/commerce/quote.server", () => ({ quoteCart: quote.quoteCart }));

// eslint-disable-next-line import/first -- imports must follow vi.mock so the fakes register first
import { createCheckout } from "./checkout.server";

function seedCartLine(shopId: string, cartId: string, line: Partial<Record<string, unknown>>) {
  if (!store.db.cart.some((c) => c.id === cartId)) {
    store.db.cart.push({ id: cartId, shop_id: shopId, state: "cart" });
  }
  store.db.cart_line.push({
    id: `cart_line-${store.db.cart_line.length + 1}`,
    shop_id: shopId,
    cart_id: cartId,
    variant_id: "v-tee-s",
    quantity: 2,
    unit_price_cents: 1999,
    currency: "usd",
    title_snapshot: "Cotton Tee - Small",
    ...line,
  });
}

beforeEach(() => {
  for (const k of Object.keys(store.db)) store.db[k].length = 0;
  vi.clearAllMocks();
  process.env.STRIPE_SECRET_KEY = "sk_test_x";
  stripe.piCreate.mockResolvedValue({
    id: "pi_1",
    client_secret: "pi_1_secret_abc",
    status: "requires_payment_method",
  });
});

describe("createCheckout", () => {
  it("creates a checkout_pending order with totals, snapshots lines, and opens a PI keyed to the order", async () => {
    seedCartLine("shop-1", "cart-1", { quantity: 2, unit_price_cents: 1999 }); // 3998

    const out = await createCheckout("shop-1", "cart-1", { email: "Buyer@Example.com" });

    // orders row born in checkout_pending with integer-cents totals (flat shipping/tax = 0).
    expect(store.db.orders).toHaveLength(1);
    const order = store.db.orders[0];
    expect(order).toMatchObject({
      shop_id: "shop-1",
      subtotal_cents: 3998,
      shipping_cents: 0,
      tax_cents: 0,
      total_cents: 3998,
      currency: "usd",
    });
    // state is left to the DB default 'checkout_pending' (not forced in the insert payload).
    expect(order.state).toBeUndefined();
    expect(Number.isInteger(order.total_cents)).toBe(true);

    // one buyer resolved, lines snapshotted onto the order.
    expect(store.db.buyer_dim).toHaveLength(1);
    expect(store.db.buyer_dim[0].email_normalized).toBe("buyer@example.com");
    expect(store.db.order_line).toHaveLength(1);
    expect(store.db.order_line[0]).toMatchObject({
      shop_id: "shop-1",
      order_id: out.orderId,
      variant_id: "v-tee-s",
      quantity: 2,
      unit_price_cents: 1999,
    });

    // PaymentIntent created for the total, with orderRef = the new order id.
    expect(stripe.piCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 3998,
        currency: "usd",
        metadata: { shop_id: "shop-1", order_ref: out.orderId },
      }),
    );
    expect(store.db.payment_intent[0]).toMatchObject({ order_ref: out.orderId, amount_cents: 3998 });
    expect(out.clientSecret).toBe("pi_1_secret_abc");

    // The source cart is consumed (cart -> checkout_pending) so open-basket
    // surfaces stop listing it; the order is the record from here on.
    expect(store.db.cart[0]).toMatchObject({ id: "cart-1", state: "checkout_pending" });
  });

  it("persists the attribution snapshot verbatim on the order (empty default)", async () => {
    seedCartLine("shop-1", "cart-1", {});
    const attribution = { clickIds: { fbclid: "fb-123" }, utm: { utm_source: "meta" } };
    const out = await createCheckout("shop-1", "cart-1", { email: "b@example.com" }, attribution);
    expect(store.db.orders[0].attribution).toEqual(attribution);

    // default is an empty object, not null/undefined.
    store.db.orders.length = 0;
    seedCartLine("shop-1", "cart-2", {});
    await createCheckout("shop-1", "cart-2", { email: "c@example.com" });
    expect(store.db.orders[0].attribution).toEqual({});
    expect(out.orderId).toMatch(/orders-/);
  });

  it("rejects an empty cart (nothing to charge) without touching buyer/order/PI", async () => {
    await expect(createCheckout("shop-1", "empty-cart", { email: "b@example.com" })).rejects.toThrow(
      /nothing to charge/,
    );
    expect(store.db.buyer_dim).toHaveLength(0);
    expect(store.db.orders).toHaveLength(0);
    expect(stripe.piCreate).not.toHaveBeenCalled();
  });

  it("rejects a non-empty cart that totals $0 BEFORE any write (no orphan checkout_pending order)", async () => {
    // All-free items: lines present, but subtotal/total = 0. Stripe can't open a $0 PI, so the
    // guard must reject on the TOTAL before writing the buyer/order/lines (else: orphan order).
    seedCartLine("shop-1", "cart-free", { quantity: 3, unit_price_cents: 0 });
    await expect(createCheckout("shop-1", "cart-free", { email: "b@example.com" })).rejects.toThrow(
      /nothing to charge/,
    );
    expect(store.db.buyer_dim).toHaveLength(0);
    expect(store.db.orders).toHaveLength(0);
    expect(store.db.order_line).toHaveLength(0);
    expect(stripe.piCreate).not.toHaveBeenCalled();
  });

  it("uses quoteCart shipping+tax when the buyer supplies a shipping address", async () => {
    // subtotal: 2 × 1999 = 3998; quoteCart returns 500 shipping + 80 tax → total 4578.
    seedCartLine("shop-1", "cart-addr", { quantity: 2, unit_price_cents: 1999 });
    quote.quoteCart.mockResolvedValueOnce({
      shippingCents: 500,
      taxCents: 80,
      subtotalCents: 3998,
      totalCents: 4578,
      currency: "usd",
      lines: [],
      deliveryEarliest: null,
      deliveryLatest: null,
      lowConfidence: false,
      fallbackUsed: false,
    });

    await createCheckout("shop-1", "cart-addr", {
      email: "addr@example.com",
      address: {
        kind: "shipping",
        line1: "123 Main St",
        city: "Springfield",
        region: "IL",
        postal: "62701",
        country: "US",
      },
    });

    expect(store.db.orders).toHaveLength(1);
    const order = store.db.orders[0];
    expect(order).toMatchObject({
      shop_id: "shop-1",
      subtotal_cents: 3998,
      shipping_cents: 500,
      tax_cents: 80,
      total_cents: 4578,
      currency: "usd",
    });
    // PI opened for the real total (subtotal + shipping + tax).
    expect(stripe.piCreate).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 4578, currency: "usd" }),
    );
  });
});
