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
    // Seeded fully-enabled in beforeEach: the charge path FAILS CLOSED without a
    // payment-ready connected account (the routing decision itself is tested in
    // connect.server.test.ts); the not-ready gate test empties it.
    stripe_connected_account: [],
    // Read by the demo-shop exemption (isShowcaseShop) when the shop is not payment-ready.
    shops: [],
    // Drives the oversell-protection read: only variants with inventory_tracked=true are reserved.
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

const stripe = vi.hoisted(() => ({ piCreate: vi.fn() }));
const quote = vi.hoisted(() => ({ quoteCart: vi.fn() }));
// Oversell protection: createCheckout reserves TRACKED lines via the inventory engine before the
// PI, cancels + releases on a stockout. The engine RPCs are unit-tested in the inventory suite;
// here we assert the WIRING (which lines get reserved, and the cancel+release+throw on stockout).
const engine = vi.hoisted(() => ({ reserveStock: vi.fn(), releaseReservation: vi.fn() }));
const order = vi.hoisted(() => ({ transitionOrder: vi.fn() }));

vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => store.client }));
vi.mock("stripe", () => ({
  default: class {
    paymentIntents = { create: stripe.piCreate };
  },
}));
vi.mock("~/lib/commerce/quote.server", () => ({ quoteCart: quote.quoteCart }));
vi.mock("~/lib/inventory/engine.server", () => ({
  reserveStock: engine.reserveStock,
  releaseReservation: engine.releaseReservation,
}));
vi.mock("~/lib/order/order.server", () => ({ transitionOrder: order.transitionOrder }));

// eslint-disable-next-line import/first -- imports must follow vi.mock so the fakes register first
import { createCheckout, OutOfStockError } from "./checkout.server";
// eslint-disable-next-line import/first -- follows vi.mock like the import above
import { PaymentsNotReadyError } from "~/lib/payments/connect.server";

/** Fully-enabled connected account: the default posture — the shop CAN take payments. */
function seedPaymentReady(shopId: string) {
  store.db.stripe_connected_account.push({
    shop_id: shopId,
    stripe_account_id: "acct_test",
    account_type: "express",
    charges_enabled: true,
    payouts_enabled: true,
    details_submitted: true,
    application_fee_bps: 0,
    application_fee_flat_cents: 0,
    country: "US",
    default_currency: "usd",
    onboarded_at: "2026-07-01T00:00:00.000Z",
  });
}

/** Seed a variant_dim row so the oversell read can classify a line as tracked/untracked, and
 *  (Phase 4 Task 1) the cost-snapshot read can resolve unit_cost_cents. */
function seedVariant(
  shopId: string,
  variantId: string,
  inventoryTracked: boolean | null,
  unitCostCents?: number | null,
) {
  store.db.variant_dim.push({
    id: variantId,
    shop_id: shopId,
    inventory_tracked: inventoryTracked,
    unit_cost_cents: unitCostCents ?? null,
  });
}

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
  seedPaymentReady("shop-1");
  stripe.piCreate.mockResolvedValue({
    id: "pi_1",
    client_secret: "pi_1_secret_abc",
    status: "requires_payment_method",
  });
  // Default: every reserve succeeds (stock available). Individual tests override for stockout.
  engine.reserveStock.mockResolvedValue({ ok: true, allocation: [{ locationId: "loc-1", qty: 1 }] });
  engine.releaseReservation.mockResolvedValue(undefined);
  order.transitionOrder.mockResolvedValue({ id: "t-1", toState: "cancelled" });
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

  it("stamps unit_cost_cents_snapshot from variant_dim onto the order_line row (Phase 4 Task 1)", async () => {
    seedCartLine("shop-1", "cart-cost", { variant_id: "v-tee-s", quantity: 2, unit_price_cents: 1999 });
    seedVariant("shop-1", "v-tee-s", true, 750);

    const out = await createCheckout("shop-1", "cart-cost", { email: "cost@example.com" });

    expect(store.db.order_line).toHaveLength(1);
    expect(store.db.order_line[0]).toMatchObject({
      order_id: out.orderId,
      variant_id: "v-tee-s",
      unit_cost_cents_snapshot: 750,
    });
  });

  it("snapshots a null unit_cost_cents_snapshot for a variant with no cost recorded (never fabricates 0)", async () => {
    seedCartLine("shop-1", "cart-nocost", { variant_id: "v-tee-s" });
    seedVariant("shop-1", "v-tee-s", false, null);

    await createCheckout("shop-1", "cart-nocost", { email: "nocost@example.com" });

    expect(store.db.order_line[0].unit_cost_cents_snapshot).toBeNull();
  });

  it("snapshots a null unit_cost_cents_snapshot when the variant has no variant_dim row at all", async () => {
    seedCartLine("shop-1", "cart-novariant", { variant_id: "v-ghost" });

    await createCheckout("shop-1", "cart-novariant", { email: "novariant@example.com" });

    expect(store.db.order_line[0].unit_cost_cents_snapshot).toBeNull();
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

  it("rejects an unsupported cart currency BEFORE any write (no orphan checkout_pending order)", async () => {
    // A merchant selling in CHF snapshots 'chf' onto the cart line; Stripe can't open a PI in an
    // unsupported currency, so the guard must reject before writing buyer/order/lines — otherwise
    // every attempt writes another orphan and re-originating loops forever.
    seedCartLine("shop-1", "cart-chf", { currency: "chf", unit_price_cents: 5000 });
    await expect(createCheckout("shop-1", "cart-chf", { email: "b@example.com" })).rejects.toThrow(
      /unsupported currency/,
    );
    expect(store.db.buyer_dim).toHaveLength(0);
    expect(store.db.orders).toHaveLength(0);
    expect(store.db.order_line).toHaveLength(0);
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

  it("reserves TRACKED lines only (keyed on the order id) before opening the PI, skipping untracked/digital lines", async () => {
    // Two lines: a tracked physical variant and an untracked digital one. Only the tracked line
    // holds ledger stock; reserving the untracked one would 422 a valid sale, so it must be skipped.
    seedCartLine("shop-1", "cart-mix", { variant_id: "v-tracked", quantity: 2, unit_price_cents: 1000 });
    store.db.cart_line.push({
      id: "cart_line-digital",
      shop_id: "shop-1",
      cart_id: "cart-mix",
      variant_id: "v-digital",
      quantity: 1,
      unit_price_cents: 500,
      currency: "usd",
      title_snapshot: "Gift Card",
    });
    seedVariant("shop-1", "v-tracked", true);
    seedVariant("shop-1", "v-digital", false);

    const out = await createCheckout("shop-1", "cart-mix", { email: "b@example.com" });

    // Exactly one reserve — for the tracked line, keyed on the new order id, not the digital line.
    expect(engine.reserveStock).toHaveBeenCalledTimes(1);
    expect(engine.reserveStock).toHaveBeenCalledWith("shop-1", "v-tracked", 2, out.orderId, null);
    // Sale proceeds: order created, PI opened, nothing released/cancelled.
    expect(store.db.orders).toHaveLength(1);
    expect(stripe.piCreate).toHaveBeenCalledTimes(1);
    expect(engine.releaseReservation).not.toHaveBeenCalled();
    expect(order.transitionOrder).not.toHaveBeenCalled();
  });

  it("cancels the order + releases holds + throws OutOfStockError on a stockout, and never opens a PI", async () => {
    seedCartLine("shop-1", "cart-oos", { variant_id: "v-tracked", quantity: 5, unit_price_cents: 1000 });
    seedVariant("shop-1", "v-tracked", true);
    // The last unit sold between add-to-cart and checkout: reserve returns a not-ok result.
    engine.reserveStock.mockResolvedValueOnce({ ok: false, reason: "insufficient_stock" });

    await expect(createCheckout("shop-1", "cart-oos", { email: "b@example.com" })).rejects.toBeInstanceOf(
      OutOfStockError,
    );

    // Partial holds freed (by order id) and the just-born order cancelled — no orphan pending order.
    expect(engine.releaseReservation).toHaveBeenCalledWith("shop-1", store.db.orders[0].id);
    expect(order.transitionOrder).toHaveBeenCalledWith(
      "shop-1",
      store.db.orders[0].id,
      "cancelled",
      "checkout:out_of_stock",
    );
    // Critically: NO PaymentIntent for stock that no longer exists (no charge on a sold-out cart).
    expect(stripe.piCreate).not.toHaveBeenCalled();
  });

  it("does not reserve or 422 when no line is tracked (all untracked/digital)", async () => {
    seedCartLine("shop-1", "cart-untracked", { variant_id: "v-digital", quantity: 1, unit_price_cents: 900 });
    seedVariant("shop-1", "v-digital", null); // null inventory_tracked = not tracked

    await createCheckout("shop-1", "cart-untracked", { email: "b@example.com" });

    expect(engine.reserveStock).not.toHaveBeenCalled();
    expect(stripe.piCreate).toHaveBeenCalledTimes(1);
  });

  it("fails CLOSED (PaymentsNotReadyError) BEFORE any write when the shop has no payment-ready Stripe account", async () => {
    // Real shop (not demo), no fully-enabled connected account: charging would settle the
    // buyer's money into the PLATFORM account, so the gate must refuse before priceCart or
    // any buyer/order/hold write — no orphan rows, no Stripe call.
    store.db.stripe_connected_account.length = 0;
    seedCartLine("shop-1", "cart-noready", {});

    await expect(createCheckout("shop-1", "cart-noready", { email: "b@example.com" })).rejects.toBeInstanceOf(
      PaymentsNotReadyError,
    );
    expect(store.db.buyer_dim).toHaveLength(0);
    expect(store.db.orders).toHaveLength(0);
    expect(store.db.order_line).toHaveLength(0);
    expect(engine.reserveStock).not.toHaveBeenCalled();
    expect(stripe.piCreate).not.toHaveBeenCalled();
  });

  it("releases holds + cancels the order when the merchant is de-onboarded between the gate and the PI (race)", async () => {
    // The gate passed (account looked enabled) but Stripe rejects the destination at PI
    // create — stale flags. Fail closed like a stockout: free holds, cancel the just-born
    // order, rethrow. No PaymentIntent exists, so nothing can be charged.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    seedCartLine("shop-1", "cart-race", { variant_id: "v-tracked", quantity: 1, unit_price_cents: 1000 });
    seedVariant("shop-1", "v-tracked", true);
    stripe.piCreate.mockRejectedValueOnce(
      Object.assign(new Error("No such destination: 'acct_test'"), {
        type: "StripeInvalidRequestError",
        code: "account_invalid",
        param: "transfer_data[destination]",
      }),
    );

    await expect(createCheckout("shop-1", "cart-race", { email: "b@example.com" })).rejects.toBeInstanceOf(
      PaymentsNotReadyError,
    );

    expect(engine.releaseReservation).toHaveBeenCalledWith("shop-1", store.db.orders[0].id);
    expect(order.transitionOrder).toHaveBeenCalledWith(
      "shop-1",
      store.db.orders[0].id,
      "cancelled",
      "checkout:payments_not_ready",
    );
    expect(store.db.payment_intent).toHaveLength(0);
    // The buyer keeps their basket: the cart is only flagged consumed AFTER a PI exists.
    expect(store.db.cart.find((c) => c.id === "cart-race")?.state).toBe("cart");
    warn.mockRestore();
  });

  it("releases holds + cancels the order on ANY PI-create failure (e.g. Stripe 5xx), leaving the cart open", async () => {
    // No PaymentIntent exists when the create rejects, so unwinding is always safe —
    // otherwise held stock blocks other buyers until the reaper and the order orphans.
    seedCartLine("shop-1", "cart-5xx", { variant_id: "v-tracked", quantity: 1, unit_price_cents: 1000 });
    seedVariant("shop-1", "v-tracked", true);
    stripe.piCreate.mockRejectedValueOnce(Object.assign(new Error("stripe unavailable"), { type: "StripeAPIError" }));

    await expect(createCheckout("shop-1", "cart-5xx", { email: "b@example.com" })).rejects.toThrow(
      /stripe unavailable/,
    );

    expect(engine.releaseReservation).toHaveBeenCalledWith("shop-1", store.db.orders[0].id);
    expect(order.transitionOrder).toHaveBeenCalledWith(
      "shop-1",
      store.db.orders[0].id,
      "cancelled",
      "checkout:payment_intent_failed",
    );
    expect(store.db.cart.find((c) => c.id === "cart-5xx")?.state).toBe("cart");
  });

  it("never replaces the original PI-create error with a cleanup failure (buyer still gets the honest status)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    seedCartLine("shop-1", "cart-cleanupfail", { variant_id: "v-tracked", quantity: 1, unit_price_cents: 1000 });
    seedVariant("shop-1", "v-tracked", true);
    stripe.piCreate.mockRejectedValueOnce(
      Object.assign(new Error("No such destination"), {
        type: "StripeInvalidRequestError",
        code: "account_invalid",
        param: "transfer_data[destination]",
      }),
    );
    engine.releaseReservation.mockRejectedValueOnce(new Error("postgrest blip"));

    // Cleanup failed, but the ORIGINAL PaymentsNotReadyError still surfaces (route maps it to 503).
    await expect(createCheckout("shop-1", "cart-cleanupfail", { email: "b@example.com" })).rejects.toBeInstanceOf(
      PaymentsNotReadyError,
    );
    expect(spy).toHaveBeenCalledWith(expect.stringMatching(/failed to unwind/), expect.anything());
    spy.mockRestore();
    warn.mockRestore();
  });
});
