import { describe, it, expect, beforeEach, vi } from "vitest";

// Hoisted mock handles shared by the Stripe SDK + Supabase mocks below.
const h = vi.hoisted(() => ({
  piCreate: vi.fn(),
  constructEvent: vi.fn(),
  insert: vi.fn(),
  upsert: vi.fn(),
  rpc: vi.fn(),
  transitionOrder: vi.fn(),
  emitPaidOrder: vi.fn(),
  commitReservation: vi.fn(),
  routedCreate: vi.fn(),
  // Current orders.state the mock returns for the redelivery self-heal read. Default 'paid' so the
  // ordinary duplicate delivery treats the order as already-advanced and does not re-transition.
  orderState: "paid" as string,
}));

// Server SDK: default export is the Stripe class; instances expose paymentIntents + webhooks.
vi.mock("stripe", () => ({
  default: class {
    paymentIntents = { create: h.piCreate };
    webhooks = { constructEvent: h.constructEvent };
  },
}));

// Service-role Supabase client. `from(...).insert` routes to h.insert (payment_intent persist);
// `from("orders").update(...).eq(shop).eq(id).eq(state)` is the financial_status='paid' stamp — a
// chainable no-op resolving { error: null } (three .eq() calls: shop_id, id, and the state guard).
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    from: () => ({
      insert: h.insert,
      upsert: h.upsert,
      update: () => ({ eq: () => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) }) }),
      // orders.state read for the redelivery self-heal (recoverStrandedPaidOrder): returns the
      // configurable h.orderState so a test can simulate a still-stranded checkout_pending order.
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { state: h.orderState }, error: null }) }) }) }),
    }),
    rpc: h.rpc,
  }),
}));

// The order spine + warehouse emission are exercised end-to-end in order.server.test.ts /
// emit.server.test.ts; here we assert the WIRING — that a confirmed capture drives exactly one
// transition + emit on first delivery, and nothing on a duplicate.
vi.mock("~/lib/order/order.server", () => ({ transitionOrder: h.transitionOrder }));
vi.mock("~/lib/order/emit.server", () => ({ emitPaidOrder: h.emitPaidOrder }));
// commitReservation turns the checkout's held reservations into on_hand decrements on payment
// success; the engine RPCs are unit-tested in the inventory suite — here we assert the WIRING.
vi.mock("~/lib/inventory/engine.server", () => ({ commitReservation: h.commitReservation }));

// Routing + fallback + decline semantics are unit-tested against
// createRoutedPaymentIntent in connect.server.test.ts; here we assert the WIRING —
// the base params handed to the seam and the row stamping of its outcome.
vi.mock("~/lib/payments/connect.server", () => ({
  createRoutedPaymentIntent: h.routedCreate,
}));

// eslint-disable-next-line import/first -- import must follow vi.mock so the stripe + supabase fakes are registered before the module under test loads
import { createPaymentIntent, processStripeEvent } from "./stripe.server";

beforeEach(() => {
  vi.clearAllMocks();
  process.env.STRIPE_SECRET_KEY = "sk_test_x";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  // Default: platform charge (today's behavior) — the seam echoes h.piCreate's PI.
  h.routedCreate.mockImplementation(async (_shopId: string, base: Record<string, unknown>) => ({
    pi: await h.piCreate(base),
    stripeAccountId: null,
    applicationFeeCents: null,
  }));
  // Defaults: a successful checkout_pending -> paid transition, then a no-op emit.
  h.transitionOrder.mockResolvedValue({
    id: "t-1",
    orderId: "order-1",
    fromState: "checkout_pending",
    toState: "paid",
    reason: "stripe:payment_intent.succeeded",
    occurredAt: "2026-06-29T12:00:00.000Z",
  });
  h.emitPaidOrder.mockResolvedValue({ externalId: "gid://calderyn/Order/order-1", sourceVersion: 1, lineCount: 1, clickRefCount: 0, skipped: false });
  h.commitReservation.mockResolvedValue(undefined);
  h.upsert.mockResolvedValue({ error: null });
  h.orderState = "paid";
});

describe("createPaymentIntent", () => {
  it("creates a Stripe PI, persists the shop-scoped row, and returns the client secret", async () => {
    h.piCreate.mockResolvedValue({
      id: "pi_1",
      client_secret: "pi_1_secret_abc",
      status: "requires_payment_method",
    });
    h.insert.mockResolvedValue({ error: null });

    const out = await createPaymentIntent("shop-1", 2500, "USD", "order-1");

    expect(h.piCreate).toHaveBeenCalledWith({
      amount: 2500,
      currency: "usd",
      automatic_payment_methods: { enabled: true },
      metadata: { shop_id: "shop-1", order_ref: "order-1" },
    });
    expect(h.insert).toHaveBeenCalledWith({
      shop_id: "shop-1",
      stripe_pi_id: "pi_1",
      order_ref: "order-1",
      amount_cents: 2500,
      currency: "usd",
      status: "requires_payment_method",
      stripe_account_id: null,
      application_fee_cents: null,
    });
    expect(out).toEqual({
      paymentIntentId: "pi_1",
      clientSecret: "pi_1_secret_abc",
      amountCents: 2500,
      currency: "usd",
    });
  });

  it("rejects non-integer / non-positive amounts and unknown currencies at the boundary", async () => {
    await expect(createPaymentIntent("shop-1", -1, "usd")).rejects.toThrow();
    await expect(createPaymentIntent("shop-1", 12.5, "usd")).rejects.toThrow();
    await expect(createPaymentIntent("shop-1", 2500, "xyz")).rejects.toThrow();
    expect(h.piCreate).not.toHaveBeenCalled();
  });

  it("hands the exact base params to the routing seam and stamps its routed outcome on the row", async () => {
    h.routedCreate.mockResolvedValue({
      pi: { id: "pi_2", client_secret: "s", status: "requires_payment_method" },
      stripeAccountId: "acct_1",
      applicationFeeCents: 280,
    });
    h.insert.mockResolvedValue({ error: null });

    await createPaymentIntent("shop-1", 10000, "usd", "order-2");

    expect(h.routedCreate).toHaveBeenCalledWith("shop-1", {
      amount: 10000,
      currency: "usd",
      automatic_payment_methods: { enabled: true },
      metadata: { shop_id: "shop-1", order_ref: "order-2" },
    });
    expect(h.insert).toHaveBeenCalledWith(
      expect.objectContaining({ stripe_account_id: "acct_1", application_fee_cents: 280 }),
    );
  });

  it("propagates a seam rejection (fallback/decline semantics live in connect.server.test.ts)", async () => {
    h.routedCreate.mockRejectedValue(Object.assign(new Error("rate limited"), { type: "StripeRateLimitError" }));
    await expect(createPaymentIntent("shop-1", 2500, "usd")).rejects.toThrow(/rate limited/);
    expect(h.insert).not.toHaveBeenCalled(); // no row for a charge that never existed
  });
});

describe("processStripeEvent", () => {
  const succeededEvent = {
    id: "evt_1",
    type: "payment_intent.succeeded",
    created: 1_700_000_000,
    data: {
      object: {
        id: "pi_1",
        amount_received: 2500,
        currency: "usd",
        latest_charge: "ch_1",
        metadata: { shop_id: "shop-1", order_ref: "order-1" },
      },
    },
  };

  it("records a payment_intent.succeeded event exactly once across duplicate deliveries", async () => {
    h.constructEvent.mockReturnValue(succeededEvent);

    // Faithful stand-in for the record_stripe_event SQL function: unique(stripe_event_id)
    // + exactly one ledger row per first delivery. The real guarantee is the DB unique
    // constraint, exercised end-to-end in the Verification task via `stripe trigger`.
    const ledger: Array<Record<string, unknown>> = [];
    const seen = new Set<string>();
    h.rpc.mockImplementation(async (_fn: string, a: Record<string, any>) => {
      if (seen.has(a.p_event_id)) return { data: false, error: null };
      seen.add(a.p_event_id);
      if (a.p_kind) {
        ledger.push({ stripe_event_id: a.p_event_id, kind: a.p_kind, amount_cents: a.p_amount_cents });
      }
      return { data: true, error: null };
    });

    const first = await processStripeEvent("raw-body", "sig");
    const second = await processStripeEvent("raw-body", "sig"); // Stripe redelivers the same evt_

    expect(first).toEqual({ status: 200, processed: true, duplicate: false });
    expect(second).toEqual({ status: 200, processed: false, duplicate: true });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ kind: "capture", amount_cents: 2500 });
    expect(h.rpc).toHaveBeenCalledTimes(2);
    // stripe_ref takes the charge id from the PI's latest_charge.
    expect(h.rpc.mock.calls[0][1]).toMatchObject({
      p_event_id: "evt_1",
      p_shop_id: "shop-1",
      p_stripe_pi_id: "pi_1",
      p_new_status: "succeeded",
      p_kind: "capture",
      p_amount_cents: 2500,
      p_stripe_ref: "ch_1",
      p_signature_verified: true,
    });
  });

  it("reconciles: the sum of captured ledger rows equals the Stripe captured amount", async () => {
    h.constructEvent.mockReturnValue(succeededEvent);
    const ledger: Array<{ amount_cents: number }> = [];
    h.rpc.mockImplementation(async (_fn: string, a: Record<string, any>) => {
      if (a.p_kind) ledger.push({ amount_cents: a.p_amount_cents });
      return { data: true, error: null };
    });

    await processStripeEvent("raw-body", "sig");

    const captured = succeededEvent.data.object.amount_received;
    const ledgerSum = ledger.reduce((acc, row) => acc + row.amount_cents, 0);
    expect(ledgerSum).toBe(captured); // ledger ties exactly to the captured charge (rule 12)
  });

  it("rejects an invalid signature with 400 and writes nothing", async () => {
    h.constructEvent.mockImplementation(() => {
      throw new Error("Webhook signature verification failed");
    });
    const res = await processStripeEvent("raw-body", "bad-sig");
    expect(res).toEqual({ status: 400, processed: false, duplicate: false });
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("rejects a missing signature with 400 and writes nothing", async () => {
    const res = await processStripeEvent("raw-body", null);
    expect(res).toEqual({ status: 400, processed: false, duplicate: false });
    expect(h.constructEvent).not.toHaveBeenCalled();
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("on payment_intent.payment_failed updates status but writes no ledger row", async () => {
    h.constructEvent.mockReturnValue({
      ...succeededEvent,
      id: "evt_2",
      type: "payment_intent.payment_failed",
    });
    const ledger: Array<Record<string, unknown>> = [];
    h.rpc.mockImplementation(async (_fn: string, a: Record<string, any>) => {
      if (a.p_kind) ledger.push({ kind: a.p_kind });
      return { data: true, error: null };
    });

    const res = await processStripeEvent("raw-body", "sig");
    expect(res).toEqual({ status: 200, processed: true, duplicate: false });
    expect(h.rpc.mock.calls[0][1]).toMatchObject({ p_new_status: "failed", p_kind: null });
    expect(ledger).toHaveLength(0); // no money moved -> no ledger row (keeps reconciliation exact)
  });

  it("acknowledges an unhandled event type with 200 and writes nothing", async () => {
    h.constructEvent.mockReturnValue({ id: "evt_3", type: "charge.updated", created: 1, data: { object: {} } });
    const res = await processStripeEvent("raw-body", "sig");
    expect(res).toEqual({ status: 200, processed: false, duplicate: false });
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("ACKs (200) and writes nothing for a PI not created by us (no shop_id metadata)", async () => {
    // A foreign PaymentIntent on the same Stripe account must NOT 500-loop forever.
    h.constructEvent.mockReturnValue({
      ...succeededEvent,
      id: "evt_foreign",
      data: { object: { id: "pi_foreign", amount_received: 999, currency: "usd", metadata: {} } },
    });
    const res = await processStripeEvent("raw-body", "sig");
    expect(res).toEqual({ status: 200, processed: false, duplicate: false });
    expect(h.rpc).not.toHaveBeenCalled();
  });

  describe("checkout.session.completed (hosted Checkout reconciliation)", () => {
    const sessionEvent = {
      id: "evt_cs",
      type: "checkout.session.completed",
      created: 1_700_000_000,
      data: {
        object: {
          id: "cs_1",
          payment_intent: "pi_hosted_1",
          amount_total: 50,
          currency: "usd",
          metadata: { shop_id: "shop-1", order_ref: "order-9" },
        },
      },
    };

    it("provisions the payment_intent row from the session and does no money work", async () => {
      h.constructEvent.mockReturnValue(sessionEvent);

      const res = await processStripeEvent("raw-body", "sig");

      expect(res).toEqual({ status: 200, processed: true, duplicate: false });
      // Reconciles the row keyed by the hosted PI id, idempotent on stripe_pi_id.
      expect(h.upsert).toHaveBeenCalledWith(
        {
          shop_id: "shop-1",
          stripe_pi_id: "pi_hosted_1",
          order_ref: "order-9",
          amount_cents: 50,
          currency: "usd",
        },
        { onConflict: "stripe_pi_id" },
      );
      // No capture / transition here — the paired payment_intent.succeeded event does that.
      expect(h.rpc).not.toHaveBeenCalled();
      expect(h.transitionOrder).not.toHaveBeenCalled();
      expect(h.emitPaidOrder).not.toHaveBeenCalled();
    });

    it("ACKs (200) and writes nothing when the session lacks shop_id or a payment_intent", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      h.constructEvent.mockReturnValue({
        ...sessionEvent,
        id: "evt_cs_bad",
        data: { object: { id: "cs_2", amount_total: 50, currency: "usd", metadata: {} } },
      });

      const res = await processStripeEvent("raw-body", "sig");

      expect(res).toEqual({ status: 200, processed: false, duplicate: false });
      expect(h.upsert).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/missing shop_id or payment_intent/));
      warn.mockRestore();
    });
  });

  describe("paid transition + warehouse emission", () => {
    // A faithful record_stripe_event stand-in: true on first delivery, false on duplicate.
    function gatedRpc() {
      const seen = new Set<string>();
      h.rpc.mockImplementation(async (_fn: string, a: Record<string, any>) => {
        if (seen.has(a.p_event_id)) return { data: false, error: null };
        seen.add(a.p_event_id);
        return { data: true, error: null };
      });
    }

    it("on first delivery of a confirmed capture, transitions the order to paid and emits to the warehouse", async () => {
      h.constructEvent.mockReturnValue(succeededEvent);
      gatedRpc();

      const res = await processStripeEvent("raw-body", "sig");

      expect(res).toEqual({ status: 200, processed: true, duplicate: false });
      expect(h.transitionOrder).toHaveBeenCalledTimes(1);
      expect(h.transitionOrder).toHaveBeenCalledWith(
        "shop-1",
        "order-1",
        "paid",
        "stripe:payment_intent.succeeded",
      );
      // emit runs AFTER the transition, keyed to the same order. source_version uses the Stripe
      // event time (stable across redeliveries of the same event).
      expect(h.emitPaidOrder).toHaveBeenCalledTimes(1);
      expect(h.emitPaidOrder).toHaveBeenCalledWith(
        "shop-1",
        "order-1",
        new Date(succeededEvent.created * 1000).toISOString(),
      );
    });

    it("does NOT re-transition on a duplicate delivery, but re-runs the (idempotent) emit", async () => {
      h.constructEvent.mockReturnValue(succeededEvent);
      gatedRpc();

      await processStripeEvent("raw-body", "sig"); // first: transitions + emits
      const second = await processStripeEvent("raw-body", "sig"); // redelivery: emit only (self-heal)

      expect(second).toEqual({ status: 200, processed: false, duplicate: true });
      expect(h.transitionOrder).toHaveBeenCalledTimes(1); // SoT never re-transitioned
      expect(h.emitPaidOrder).toHaveBeenCalledTimes(2); // emit re-runs on every succeeded delivery
    });

    it("self-heals: first-delivery emit throws (surfaced), then a redelivery re-runs emit with no second transition", async () => {
      h.constructEvent.mockReturnValue(succeededEvent);
      gatedRpc();
      // First delivery: the order transitions to paid, then emit throws (transient warehouse blip).
      h.emitPaidOrder.mockRejectedValueOnce(new Error("transient warehouse blip"));

      await expect(processStripeEvent("raw-body", "sig")).rejects.toThrow(/transient warehouse blip/);
      expect(h.transitionOrder).toHaveBeenCalledTimes(1);
      expect(h.emitPaidOrder).toHaveBeenCalledTimes(1); // attempted, failed

      // Stripe redelivers the SAME event: record_stripe_event returns false (duplicate), the order
      // is already paid, so emit re-runs (now succeeds) and the order is NOT transitioned again.
      const redelivery = await processStripeEvent("raw-body", "sig");
      expect(redelivery).toEqual({ status: 200, processed: false, duplicate: true });
      expect(h.transitionOrder).toHaveBeenCalledTimes(1); // still one paid transition -> one audit row
      expect(h.emitPaidOrder).toHaveBeenCalledTimes(2); // emit re-ran -> order_fact lands on the retry
    });

    it("does not force-pay an order that is not checkout_pending — the state machine rejection propagates and nothing is emitted", async () => {
      h.constructEvent.mockReturnValue(succeededEvent);
      gatedRpc();
      h.transitionOrder.mockRejectedValueOnce(
        new Error("illegal order transition paid -> paid; allowed from paid: fulfilled, refunded"),
      );

      await expect(processStripeEvent("raw-body", "sig")).rejects.toThrow(/illegal order transition/);
      expect(h.emitPaidOrder).not.toHaveBeenCalled();
    });

    it("does not transition on a payment_failed event (no capture, no paid state)", async () => {
      h.constructEvent.mockReturnValue({ ...succeededEvent, id: "evt_failed", type: "payment_intent.payment_failed" });
      gatedRpc();

      await processStripeEvent("raw-body", "sig");
      expect(h.transitionOrder).not.toHaveBeenCalled();
      expect(h.emitPaidOrder).not.toHaveBeenCalled();
      expect(h.commitReservation).not.toHaveBeenCalled(); // holds are NOT released on failure (PI retries)
    });

    it("commits the checkout's inventory reservation on a confirmed capture, keyed to the order", async () => {
      h.constructEvent.mockReturnValue(succeededEvent);
      gatedRpc();

      await processStripeEvent("raw-body", "sig");

      // reserve-at-checkout / commit-on-payment: the held reservation (keyed on the order id) is
      // turned into a real on_hand decrement so the storefront path stops overselling.
      expect(h.commitReservation).toHaveBeenCalledTimes(1);
      expect(h.commitReservation).toHaveBeenCalledWith("shop-1", "order-1");
    });

    it("re-runs the (idempotent) inventory commit on a duplicate delivery (self-heal)", async () => {
      h.constructEvent.mockReturnValue(succeededEvent);
      gatedRpc();

      await processStripeEvent("raw-body", "sig"); // first
      await processStripeEvent("raw-body", "sig"); // redelivery

      // inventory_commit only flips still-held rows, so re-running it every succeeded delivery is a
      // safe self-heal (a redelivery finds nothing held and no-ops).
      expect(h.commitReservation).toHaveBeenCalledTimes(2);
    });

    it("self-heals a stranded checkout_pending order: first-delivery transition throws, redelivery recovers it to paid", async () => {
      h.constructEvent.mockReturnValue(succeededEvent);
      gatedRpc();
      // The order is still checkout_pending throughout the stranding window.
      h.orderState = "checkout_pending";
      // First delivery: event recorded, then the paid transition throws (transient) -> handler throws.
      // Only the FIRST call rejects; the recovery call on redelivery uses the default resolve.
      h.transitionOrder.mockRejectedValueOnce(new Error("transient transition blip"));

      await expect(processStripeEvent("raw-body", "sig")).rejects.toThrow(/transient transition blip/);
      expect(h.transitionOrder).toHaveBeenCalledTimes(1);

      // Stripe redelivers: record_stripe_event returns false (duplicate), but because the order is
      // STILL checkout_pending the recovery re-drives the transition to paid instead of skipping it
      // forever (the bug: a captured order stranded as "Abandoned", never fulfilled).
      const redelivery = await processStripeEvent("raw-body", "sig");
      expect(redelivery).toEqual({ status: 200, processed: false, duplicate: true });
      expect(h.transitionOrder).toHaveBeenCalledTimes(2);
      expect(h.transitionOrder).toHaveBeenLastCalledWith(
        "shop-1",
        "order-1",
        "paid",
        expect.stringMatching(/recovery/),
      );
    });

    it("does NOT recover on a duplicate delivery once the order already reached paid", async () => {
      h.constructEvent.mockReturnValue(succeededEvent);
      gatedRpc();

      await processStripeEvent("raw-body", "sig"); // first: transitions to paid
      h.orderState = "paid"; // the order is now paid (ordinary duplicate)
      await processStripeEvent("raw-body", "sig"); // redelivery: recovery must be a no-op

      expect(h.transitionOrder).toHaveBeenCalledTimes(1); // never re-transitioned
    });

    it("skips the transition (with a warning) when a succeeded PI carries no order_ref", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      h.constructEvent.mockReturnValue({
        ...succeededEvent,
        id: "evt_no_ref",
        data: { object: { ...succeededEvent.data.object, metadata: { shop_id: "shop-1" } } },
      });
      gatedRpc();

      const res = await processStripeEvent("raw-body", "sig");
      expect(res).toEqual({ status: 200, processed: true, duplicate: false });
      expect(h.transitionOrder).not.toHaveBeenCalled();
      expect(h.emitPaidOrder).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/no order_ref/));
      warn.mockRestore();
    });
  });
});
