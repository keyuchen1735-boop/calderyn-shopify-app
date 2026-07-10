import { describe, it, expect, beforeEach, vi } from "vitest";

// In-memory stand-in for the tables sendDraftOrderInvoice/payableInvoiceSession touch (cart/
// cart_line read by priceCart, buyer_dim/buyer_address written by upsertGuestBuyer/addBuyerAddress,
// orders + order_line written here). Same Builder shape/convention as checkout.server.test.ts.
const store = vi.hoisted(() => {
  type Row = Record<string, any>;
  const db: Record<string, Row[]> = {
    cart: [],
    cart_line: [],
    buyer_dim: [],
    buyer_address: [],
    orders: [],
    order_line: [],
    stripe_connected_account: [],
    shops: [],
  };

  class Builder {
    private op: "select" | "insert" | "update" | "upsert" | "delete" = "select";
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
    delete() {
      this.op = "delete";
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
    private matches(r: Row) {
      return this.filters.every(([c, v]) => r[c] === v);
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
        const matched = t.filter((r) => this.matches(r));
        for (const r of matched) Object.assign(r, this.vals);
        return this.wrap(matched);
      }
      if (this.op === "delete") {
        const matched = t.filter((r) => this.matches(r));
        for (const r of matched) t.splice(t.indexOf(r), 1);
        return this.wrap(matched);
      }
      const matched = t.filter((r) => this.matches(r));
      return this.wrap(matched);
    }
  }

  const client = { from: (table: string) => new Builder(table) };
  return { db, client };
});

const stripeCheckout = vi.hoisted(() => ({ createCommerceCheckoutSession: vi.fn() }));
const emailer = vi.hoisted(() => ({ sendInvoiceEmail: vi.fn() }));
const quote = vi.hoisted(() => ({ quoteCart: vi.fn() }));
const stripeClient = vi.hoisted(() => ({ expire: vi.fn() }));

vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => store.client }));
vi.mock("~/lib/commerce/stripe-checkout.server", () => ({
  createCommerceCheckoutSession: stripeCheckout.createCommerceCheckoutSession,
}));
vi.mock("~/lib/commerce/quote.server", () => ({ quoteCart: quote.quoteCart }));
vi.mock("./notify-email.server", () => ({ sendInvoiceEmail: emailer.sendInvoiceEmail }));
vi.mock("~/lib/payments/stripe-client.server", () => ({
  getStripe: () => ({ checkout: { sessions: { expire: stripeClient.expire } } }),
}));

// eslint-disable-next-line import/first -- imports must follow vi.mock so the fakes register first
import { sendDraftOrderInvoice, payableInvoiceSession } from "./invoice.server";
// eslint-disable-next-line import/first -- follows vi.mock like the import above
import { PaymentsNotReadyError } from "~/lib/payments/errors";

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

function seedDraftCart(shopId: string, cartId: string, line: Partial<Record<string, unknown>> = {}) {
  if (!store.db.cart.some((c) => c.id === cartId)) {
    store.db.cart.push({ id: cartId, shop_id: shopId, state: "cart", origin: "merchant_draft" });
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
  seedPaymentReady("shop-1");
  emailer.sendInvoiceEmail.mockResolvedValue({ sent: true, id: "email-1" });
  stripeCheckout.createCommerceCheckoutSession.mockResolvedValue({ sessionId: "cs_1", url: "https://stripe/pay/cs_1" });
  stripeClient.expire.mockResolvedValue({});
});

describe("sendDraftOrderInvoice", () => {
  it("sends the invoice: order channel invoice, lines snapshotted, cart consumed, email fired, no reservation/PI", async () => {
    seedDraftCart("shop-1", "cart-1", { quantity: 2, unit_price_cents: 1999 }); // 3998

    const out = await sendDraftOrderInvoice("shop-1", "cart-1", { email: "Buyer@Example.com" });

    expect(store.db.orders).toHaveLength(1);
    const order = store.db.orders[0];
    expect(order).toMatchObject({
      shop_id: "shop-1",
      channel: "invoice",
      subtotal_cents: 3998,
      shipping_cents: 0,
      tax_cents: 0,
      total_cents: 3998,
      currency: "usd",
    });
    expect(out.orderId).toBe(order.id);
    expect(out.totalCents).toBe(3998);
    expect(out.currency).toBe("usd");

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

    // Draft cart consumed.
    expect(store.db.cart[0]).toMatchObject({ id: "cart-1", state: "checkout_pending" });

    // The invoice email fired with the confirmation token + line summary + total.
    expect(emailer.sendInvoiceEmail).toHaveBeenCalledWith(
      "shop-1",
      out.orderId,
      expect.objectContaining({
        confirmationToken: out.confirmationToken,
        totalCents: 3998,
        lines: [{ title: "Cotton Tee - Small", quantity: 2 }],
      }),
    );
    expect(out.emailSent).toBe(true);
    expect(typeof out.confirmationToken).toBe("string");
    expect(out.confirmationToken.length).toBeGreaterThan(10);

    // No inventory reservation, no PaymentIntent creation — invoice.server.ts must never import
    // the inventory engine or a PI-create seam at all (this is a shape assertion via absence).
    expect(stripeCheckout.createCommerceCheckoutSession).not.toHaveBeenCalled();
  });

  it("fails CLOSED (409 payments_not_ready) BEFORE any write when the shop cannot accept payments", async () => {
    store.db.stripe_connected_account.length = 0;
    seedDraftCart("shop-1", "cart-noready");

    await expect(sendDraftOrderInvoice("shop-1", "cart-noready", { email: "b@example.com" })).rejects.toMatchObject({
      status: 409,
      code: "payments_not_ready",
    });
    expect(store.db.buyer_dim).toHaveLength(0);
    expect(store.db.orders).toHaveLength(0);
    expect(store.db.order_line).toHaveLength(0);
    expect(emailer.sendInvoiceEmail).not.toHaveBeenCalled();
  });

  it("rejects a cart that is not a merchant draft (404) without writing anything", async () => {
    store.db.cart.push({ id: "cart-plain", shop_id: "shop-1", state: "cart", origin: null });
    store.db.cart_line.push({
      id: "cl-1",
      shop_id: "shop-1",
      cart_id: "cart-plain",
      variant_id: "v-tee-s",
      quantity: 1,
      unit_price_cents: 1999,
      currency: "usd",
      title_snapshot: "Cotton Tee",
    });

    await expect(sendDraftOrderInvoice("shop-1", "cart-plain", { email: "b@example.com" })).rejects.toMatchObject({
      status: 404,
      code: "not_a_draft",
    });
    expect(store.db.orders).toHaveLength(0);
  });

  it("rejects re-invoicing an already-consumed draft (409 draft_already_sent) without writing anything", async () => {
    // origin is still 'merchant_draft' but state already advanced past 'cart' — this is the
    // double-click / retried-request shape Fix 1 guards: the draft was already turned into an
    // invoice once (sendDraftOrderInvoice's own cart update at the bottom of this function).
    store.db.cart.push({ id: "cart-sent", shop_id: "shop-1", state: "checkout_pending", origin: "merchant_draft" });

    await expect(sendDraftOrderInvoice("shop-1", "cart-sent", { email: "b@example.com" })).rejects.toMatchObject({
      status: 409,
      code: "draft_already_sent",
    });
    expect(store.db.buyer_dim).toHaveLength(0);
    expect(store.db.orders).toHaveLength(0);
    expect(store.db.order_line).toHaveLength(0);
    expect(emailer.sendInvoiceEmail).not.toHaveBeenCalled();
  });

  it("rejects an empty draft (422) without writing anything", async () => {
    store.db.cart.push({ id: "cart-empty", shop_id: "shop-1", state: "cart", origin: "merchant_draft" });

    await expect(sendDraftOrderInvoice("shop-1", "cart-empty", { email: "b@example.com" })).rejects.toMatchObject({
      status: 422,
      code: "empty_draft",
    });
    expect(store.db.orders).toHaveLength(0);
  });

  it("rejects a non-empty draft that totals $0 (422) before any buyer/order write", async () => {
    seedDraftCart("shop-1", "cart-free", { quantity: 3, unit_price_cents: 0 });

    await expect(sendDraftOrderInvoice("shop-1", "cart-free", { email: "b@example.com" })).rejects.toMatchObject({
      status: 422,
      code: "zero_total",
    });
    expect(store.db.buyer_dim).toHaveLength(0);
    expect(store.db.orders).toHaveLength(0);
  });

  it("quotes shipping+tax via quoteCart when an address is supplied", async () => {
    seedDraftCart("shop-1", "cart-addr", { quantity: 2, unit_price_cents: 1999 });
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

    const out = await sendDraftOrderInvoice("shop-1", "cart-addr", {
      email: "addr@example.com",
      address: { kind: "shipping", line1: "123 Main St", city: "Springfield", region: "IL", postal: "62701", country: "US" },
    });

    expect(store.db.orders[0]).toMatchObject({ shipping_cents: 500, tax_cents: 80, total_cents: 4578 });
    expect(out.totalCents).toBe(4578);
  });

  it("includes the merchant note on the email but records no consent", async () => {
    seedDraftCart("shop-1", "cart-note");
    await sendDraftOrderInvoice("shop-1", "cart-note", { email: "b@example.com", note: "Pay within 7 days" });
    expect(emailer.sendInvoiceEmail).toHaveBeenCalledWith(
      "shop-1",
      expect.any(String),
      expect.objectContaining({ note: "Pay within 7 days" }),
    );
    expect(store.db.buyer_dim.some((b) => "consent" in b)).toBe(false);
  });
});

describe("payableInvoiceSession", () => {
  function seedInvoiceOrder(overrides: Partial<Record<string, unknown>> = {}) {
    const row = {
      id: "order-1",
      shop_id: "shop-1",
      channel: "invoice",
      state: "checkout_pending",
      total_cents: 3998,
      currency: "usd",
      confirmation_token: "tok-abc",
      ...overrides,
    };
    store.db.orders.push(row);
    return row;
  }

  it("mints a fresh hosted session for a checkout_pending invoice and persists its id", async () => {
    seedInvoiceOrder();
    const result = await payableInvoiceSession("shop-1", "tok-abc");
    expect(result).toEqual({ kind: "pay", url: "https://stripe/pay/cs_1" });
    expect(stripeCheckout.createCommerceCheckoutSession).toHaveBeenCalledWith("shop-1", {
      orderId: "order-1",
      totalCents: 3998,
      currency: "usd",
      confirmationToken: "tok-abc",
    });
    // No prior session on this order, so nothing to expire.
    expect(stripeClient.expire).not.toHaveBeenCalled();
    expect(store.db.orders[0]).toMatchObject({ invoice_session_id: "cs_1" });
  });

  it("expires the PRIOR hosted session before minting + persisting a replacement", async () => {
    seedInvoiceOrder({ invoice_session_id: "cs_prev" });
    stripeCheckout.createCommerceCheckoutSession.mockResolvedValue({ sessionId: "cs_new", url: "https://stripe/pay/cs_new" });

    const result = await payableInvoiceSession("shop-1", "tok-abc");

    expect(stripeClient.expire).toHaveBeenCalledWith("cs_prev");
    expect(result).toEqual({ kind: "pay", url: "https://stripe/pay/cs_new" });
    expect(store.db.orders[0]).toMatchObject({ invoice_session_id: "cs_new" });
  });

  it("swallows an expire failure (session already completed/expired) and still mints + persists a fresh session", async () => {
    seedInvoiceOrder({ invoice_session_id: "cs_prev" });
    stripeClient.expire.mockRejectedValueOnce(new Error("No such checkout session"));
    stripeCheckout.createCommerceCheckoutSession.mockResolvedValue({ sessionId: "cs_new", url: "https://stripe/pay/cs_new" });

    const result = await payableInvoiceSession("shop-1", "tok-abc");

    expect(result).toEqual({ kind: "pay", url: "https://stripe/pay/cs_new" });
    expect(store.db.orders[0]).toMatchObject({ invoice_session_id: "cs_new" });
  });

  it("mints a NEW session on every call, expiring the previous one each time", async () => {
    seedInvoiceOrder();
    stripeCheckout.createCommerceCheckoutSession
      .mockResolvedValueOnce({ sessionId: "cs_1", url: "https://stripe/pay/cs_1" })
      .mockResolvedValueOnce({ sessionId: "cs_2", url: "https://stripe/pay/cs_2" });
    const first = await payableInvoiceSession("shop-1", "tok-abc");
    const second = await payableInvoiceSession("shop-1", "tok-abc");
    expect(first).toEqual({ kind: "pay", url: "https://stripe/pay/cs_1" });
    expect(second).toEqual({ kind: "pay", url: "https://stripe/pay/cs_2" });
    expect(stripeCheckout.createCommerceCheckoutSession).toHaveBeenCalledTimes(2);
    // Second call finds the first call's persisted session id and expires it.
    expect(stripeClient.expire).toHaveBeenCalledWith("cs_1");
    expect(store.db.orders[0]).toMatchObject({ invoice_session_id: "cs_2" });
  });

  it("maps a PaymentsNotReadyError from session creation to kind not_ready, without persisting anything", async () => {
    seedInvoiceOrder();
    stripeCheckout.createCommerceCheckoutSession.mockRejectedValueOnce(
      new PaymentsNotReadyError("shop-1", "onboarding_incomplete"),
    );

    const result = await payableInvoiceSession("shop-1", "tok-abc");

    expect(result).toEqual({ kind: "not_ready" });
    expect(store.db.orders[0].invoice_session_id).toBeUndefined();
  });

  it("returns paid for a paid order, WITHOUT minting a session", async () => {
    seedInvoiceOrder({ state: "paid" });
    const result = await payableInvoiceSession("shop-1", "tok-abc");
    expect(result).toEqual({ kind: "paid", confirmationToken: "tok-abc" });
    expect(stripeCheckout.createCommerceCheckoutSession).not.toHaveBeenCalled();
  });

  it("returns paid for fulfilled/partially_fulfilled/partially_refunded states", async () => {
    for (const state of ["fulfilled", "partially_fulfilled", "partially_refunded"]) {
      store.db.orders.length = 0;
      seedInvoiceOrder({ state });
      const result = await payableInvoiceSession("shop-1", "tok-abc");
      expect(result).toEqual({ kind: "paid", confirmationToken: "tok-abc" });
    }
  });

  it("returns void for a cancelled or refunded order", async () => {
    seedInvoiceOrder({ state: "cancelled" });
    expect(await payableInvoiceSession("shop-1", "tok-abc")).toEqual({ kind: "void" });

    store.db.orders.length = 0;
    seedInvoiceOrder({ state: "refunded" });
    expect(await payableInvoiceSession("shop-1", "tok-abc")).toEqual({ kind: "void" });
  });

  it("returns null for a wrong-channel order (not an invoice)", async () => {
    seedInvoiceOrder({ channel: "storefront" });
    expect(await payableInvoiceSession("shop-1", "tok-abc")).toBeNull();
  });

  it("returns null for an unknown token", async () => {
    expect(await payableInvoiceSession("shop-1", "no-such-token")).toBeNull();
  });

  it("returns null for a foreign-shop token (shop-scoped)", async () => {
    seedInvoiceOrder();
    expect(await payableInvoiceSession("other-shop", "tok-abc")).toBeNull();
  });
});
