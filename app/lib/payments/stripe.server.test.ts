import { describe, it, expect, beforeEach, vi } from "vitest";

// Shape of the payment_intent row the charge.refunded / charge.dispute.created lookup returns.
interface PiLookupRow {
  id: string;
  shop_id: string;
  order_ref: string | null;
  currency: string;
}

// Hoisted mock handles shared by the Stripe SDK + Supabase mocks below.
const h = vi.hoisted(() => ({
  piCreate: vi.fn(),
  piRetrieve: vi.fn(),
  refundsList: vi.fn(),
  constructEvent: vi.fn(),
  insert: vi.fn(),
  upsert: vi.fn(),
  rpc: vi.fn(),
  transitionOrder: vi.fn(),
  emitPaidOrder: vi.fn(),
  commitReservation: vi.fn(),
  saleFallbackForOrder: vi.fn(),
  // inventory_reservation lookup (paid-without-hold fallback gate) by checkout_ref. Default: a row
  // is found (as a normal checkout would have — held then committed), so the fallback is NOT
  // triggered by default; tests that need the no-hold path override this to an empty array.
  reservationLookup: vi.fn(async (): Promise<{ data: Array<{ id: string }> | null; error: null }> => ({
    data: [{ id: "resv-1" }],
    error: null,
  })),
  routedCreate: vi.fn(),
  applyAccountUpdate: vi.fn(),
  // payment_intent row lookup by stripe_pi_id (charge.refunded / charge.dispute.created). Default:
  // not found ("charge not originated by Calderyn") — tests that need a match override it.
  piLookup: vi.fn(async (): Promise<{ data: PiLookupRow | null; error: null }> => ({ data: null, error: null })),
  // payment_intent rows for an order_ref (findOtherSucceededPaymentIntentId, the duplicate-capture
  // CRITICAL log's best-effort "other PI id" lookup). Default: none — tests that need the CRITICAL
  // log to name a prior PI override this.
  piListLookup: vi.fn(async (): Promise<{ data: Array<{ stripe_pi_id: string; status: string }>; error: null }> => ({
    data: [],
    error: null,
  })),
  // Captures every orders.update(patch) call (financial_status stamps) for assertion.
  ordersUpdate: vi.fn(),
  // Current orders.state the mock returns for the redelivery self-heal read / the charge.refunded
  // reconciliation read. Default 'paid' so the ordinary duplicate delivery treats the order as
  // already-advanced and does not re-transition.
  orderState: "paid" as string,
}));

// Server SDK: default export is the Stripe class; instances expose paymentIntents + webhooks +
// refunds (charge.refunded pulls the charge's authoritative refund list here).
vi.mock("stripe", () => ({
  default: class {
    paymentIntents = { create: h.piCreate, retrieve: h.piRetrieve };
    refunds = { list: h.refundsList };
    webhooks = { constructEvent: h.constructEvent };
  },
}));

// Service-role Supabase client, routed by table name.
// "payment_intent": insert/upsert (existing PI persist/reconcile paths) + a select().eq().maybeSingle()
// lookup by stripe_pi_id for charge.refunded / charge.dispute.created, resolved by h.piLookup.
// "orders" (default): select().eq().eq().maybeSingle() for the state read (redelivery self-heal +
// charge.refunded reconciliation), and a chainable update() (any number of .eq()/.in() calls then
// awaited) for the financial_status stamps — captured via h.ordersUpdate.
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    from: (table: string) => {
      if (table === "payment_intent") {
        return {
          insert: h.insert,
          upsert: h.upsert,
          select: () => ({
            eq: () => ({
              maybeSingle: () => h.piLookup(),
              // findOtherSucceededPaymentIntentId awaits select().eq() directly (no maybeSingle) —
              // a plain array read, backed by h.piListLookup.
              then: (resolve: (r: { data: unknown; error: null }) => void) => h.piListLookup().then(resolve),
            }),
          }),
        };
      }
      if (table === "inventory_reservation") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                in: () => ({ limit: () => h.reservationLookup() }),
              }),
            }),
          }),
        };
      }
      return {
        insert: h.insert,
        upsert: h.upsert,
        update: (patch: Record<string, unknown>) => {
          h.ordersUpdate(patch);
          const chain: { eq: () => typeof chain; in: () => typeof chain; then: (resolve: (r: { error: null }) => void) => void } = {
            eq: () => chain,
            in: () => chain,
            then: (resolve) => resolve({ error: null }),
          };
          return chain;
        },
        select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { state: h.orderState }, error: null }) }) }) }),
      };
    },
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
vi.mock("~/lib/inventory/engine.server", () => ({
  commitReservation: h.commitReservation,
  saleFallbackForOrder: h.saleFallbackForOrder,
}));

// Routing + fallback + decline semantics are unit-tested against
// createRoutedPaymentIntent in connect.server.test.ts; here we assert the WIRING —
// the base params handed to the seam and the row stamping of its outcome.
vi.mock("~/lib/payments/connect.server", () => ({
  createRoutedPaymentIntent: h.routedCreate,
  applyAccountUpdate: h.applyAccountUpdate,
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
  h.saleFallbackForOrder.mockResolvedValue({ decremented: 0 });
  h.reservationLookup.mockResolvedValue({ data: [{ id: "resv-1" }], error: null });
  h.applyAccountUpdate.mockResolvedValue(true);
  h.upsert.mockResolvedValue({ error: null });
  h.orderState = "paid";
  // clearAllMocks() preserves prior mockResolvedValue overrides, so re-assert the "not found"
  // default every test to avoid bleed-through from a previous test's override.
  h.piLookup.mockResolvedValue({ data: null, error: null });
  h.piListLookup.mockResolvedValue({ data: [], error: null });
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

    expect(h.routedCreate).toHaveBeenCalledWith(
      "shop-1",
      {
        amount: 10000,
        currency: "usd",
        automatic_payment_methods: { enabled: true },
        metadata: { shop_id: "shop-1", order_ref: "order-2" },
      },
      { readiness: undefined },
    );
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

  describe("account.updated (Connect async enablement re-sync)", () => {
    const accountEvent = {
      id: "evt_acct",
      type: "account.updated",
      created: 1_700_000_000,
      account: "acct_1",
      data: { object: { id: "acct_1", charges_enabled: true, payouts_enabled: true, details_submitted: true } },
    };

    it("syncs the stored connected-account row from the event and does no money work", async () => {
      h.constructEvent.mockReturnValue(accountEvent);
      const res = await processStripeEvent("raw-body", "sig");
      expect(res).toEqual({ status: 200, processed: true, duplicate: false });
      // The routing row is re-synced from the event's account object (charges now enabled), so
      // subsequent PaymentIntents route to the merchant account instead of the platform account.
      expect(h.applyAccountUpdate).toHaveBeenCalledWith(accountEvent.data.object);
      expect(h.rpc).not.toHaveBeenCalled();
      expect(h.transitionOrder).not.toHaveBeenCalled();
    });

    it("ACKs (200, processed:false) for an account.updated we don't track", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      h.applyAccountUpdate.mockResolvedValueOnce(false); // no connected-account row matched
      h.constructEvent.mockReturnValue({ ...accountEvent, id: "evt_acct_foreign" });
      const res = await processStripeEvent("raw-body", "sig");
      expect(res).toEqual({ status: 200, processed: false, duplicate: false });
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/not linked to any shop/));
      warn.mockRestore();
    });
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
      // Platform-charged session (demo shop): the PI carries no transfer_data.
      h.piRetrieve.mockResolvedValue({ id: "pi_hosted_1", transfer_data: null, application_fee_amount: null });

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
          stripe_account_id: null,
          application_fee_cents: null,
        },
        { onConflict: "stripe_pi_id" },
      );
      // No capture / transition here — the paired payment_intent.succeeded event does that.
      expect(h.rpc).not.toHaveBeenCalled();
      expect(h.transitionOrder).not.toHaveBeenCalled();
      expect(h.emitPaidOrder).not.toHaveBeenCalled();
    });

    it("stamps the routing columns for a destination-routed session so refunds reverse the transfer", async () => {
      // Hosted-session charges route to the merchant like every other site; the refund
      // path decides reverse_transfer off this row's stripe_account_id — a null stamp on
      // a routed charge would make the platform pay the buyer while the merchant keeps
      // the transferred funds.
      h.constructEvent.mockReturnValue(sessionEvent);
      h.piRetrieve.mockResolvedValue({
        id: "pi_hosted_1",
        transfer_data: { destination: "acct_1" },
        application_fee_amount: 42,
      });

      const res = await processStripeEvent("raw-body", "sig");

      expect(res).toEqual({ status: 200, processed: true, duplicate: false });
      expect(h.piRetrieve).toHaveBeenCalledWith("pi_hosted_1");
      expect(h.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ stripe_account_id: "acct_1", application_fee_cents: 42 }),
        { onConflict: "stripe_pi_id" },
      );
    });

    it("500s (Stripe redelivers) when the PI read fails, rather than reconciling a routed charge as platform", async () => {
      h.constructEvent.mockReturnValue(sessionEvent);
      h.piRetrieve.mockRejectedValue(new Error("stripe down"));

      await expect(processStripeEvent("raw-body", "sig")).rejects.toThrow(/stripe down/);
      expect(h.upsert).not.toHaveBeenCalled();
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

    it("treats a genuinely-new PI succeeding against an already-paid order as a duplicate capture: CRITICAL log, 200, no throw", async () => {
      // Two live pay sessions each mint their own PaymentIntent; the buyer completes both. This
      // event is a genuinely NEW Stripe event (gatedRpc treats it as first delivery), but the
      // order already reached 'paid' through the OTHER PaymentIntent, so transitionOrder's
      // paid->paid attempt is illegal. Fix 2c: surface it loudly instead of failing the delivery.
      h.constructEvent.mockReturnValue(succeededEvent);
      gatedRpc();
      h.transitionOrder.mockRejectedValueOnce(
        new Error("illegal order transition paid -> paid; allowed from paid: fulfilled, refunded"),
      );
      h.orderState = "paid"; // re-read confirms the order is already paid-like
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const res = await processStripeEvent("raw-body", "sig");

      expect(res).toEqual({ status: 200, processed: true, duplicate: false });
      expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/CRITICAL duplicate capture/));
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("order-1"));
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("pi_1"));
      // The already-paid-order steps below still run as state-guarded no-ops — money/inventory
      // bookkeeping stays correct even though the transition itself was refused.
      expect(h.emitPaidOrder).toHaveBeenCalledTimes(1);
      expect(h.commitReservation).toHaveBeenCalledTimes(1);
      errorSpy.mockRestore();
    });

    it("names the PRIOR PaymentIntent id in the CRITICAL log when one can be found", async () => {
      h.constructEvent.mockReturnValue(succeededEvent); // this event's PI is pi_1
      gatedRpc();
      h.transitionOrder.mockRejectedValueOnce(
        new Error("illegal order transition paid -> paid; allowed from paid: fulfilled, refunded"),
      );
      h.orderState = "paid";
      h.piListLookup.mockResolvedValue({
        data: [
          { stripe_pi_id: "pi_1", status: "succeeded" },
          { stripe_pi_id: "pi_0_prior", status: "succeeded" },
        ],
        error: null,
      });
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await processStripeEvent("raw-body", "sig");

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("pi_0_prior"));
      errorSpy.mockRestore();
    });

    it("rethrows an illegal transition that is NOT the duplicate-capture shape (order isn't paid-like)", async () => {
      // Some OTHER illegal transition (e.g. the order was concurrently cancelled) must not be
      // silently swallowed just because the error message matches "illegal order transition".
      h.constructEvent.mockReturnValue(succeededEvent);
      gatedRpc();
      h.transitionOrder.mockRejectedValueOnce(
        new Error("illegal order transition cancelled -> paid; allowed from cancelled: (none — terminal state)"),
      );
      h.orderState = "cancelled";

      await expect(processStripeEvent("raw-body", "sig")).rejects.toThrow(/illegal order transition/);
      expect(h.emitPaidOrder).not.toHaveBeenCalled();
    });

    it("normal first payment is unaffected: no console.error, clean transition", async () => {
      h.constructEvent.mockReturnValue(succeededEvent);
      gatedRpc();
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const res = await processStripeEvent("raw-body", "sig");

      expect(res).toEqual({ status: 200, processed: true, duplicate: false });
      expect(errorSpy).not.toHaveBeenCalled();
      errorSpy.mockRestore();
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

    it("falls back to a direct stock decrement when NO reservation was ever held for the order", async () => {
      h.constructEvent.mockReturnValue(succeededEvent);
      gatedRpc();
      h.reservationLookup.mockResolvedValue({ data: [], error: null }); // nothing held

      await processStripeEvent("raw-body", "sig");

      expect(h.saleFallbackForOrder).toHaveBeenCalledTimes(1);
      expect(h.saleFallbackForOrder).toHaveBeenCalledWith("shop-1", "order-1");
    });

    it("does NOT fall back when a reservation was held for the order (the ordinary commit path)", async () => {
      h.constructEvent.mockReturnValue(succeededEvent);
      gatedRpc();
      h.reservationLookup.mockResolvedValue({ data: [{ id: "resv-1" }], error: null });

      await processStripeEvent("raw-body", "sig");

      expect(h.saleFallbackForOrder).not.toHaveBeenCalled();
    });

    it("falls back when a reservation was released (30-min hold TTL expired before payment)", async () => {
      h.constructEvent.mockReturnValue(succeededEvent);
      gatedRpc();
      h.reservationLookup.mockResolvedValue({ data: [], error: null }); // no held/committed rows

      await processStripeEvent("raw-body", "sig");

      expect(h.saleFallbackForOrder).toHaveBeenCalledTimes(1);
      expect(h.saleFallbackForOrder).toHaveBeenCalledWith("shop-1", "order-1");
    });

    it("never fails the webhook when the stock fallback throws — payment already happened, logged loudly instead", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      h.constructEvent.mockReturnValue(succeededEvent);
      gatedRpc();
      h.reservationLookup.mockResolvedValue({ data: [], error: null });
      h.saleFallbackForOrder.mockRejectedValueOnce(new Error("inventory_sale_fallback: deadlock"));

      const res = await processStripeEvent("raw-body", "sig");

      expect(res).toEqual({ status: 200, processed: true, duplicate: false });
      expect(h.saleFallbackForOrder).toHaveBeenCalledTimes(1);
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringMatching(/paid-without-hold stock fallback failed/),
        expect.any(Error),
      );
      errSpy.mockRestore();
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

  describe("charge.refunded (Stripe-dashboard-originated refunds)", () => {
    function chargeRefundedEvent(overrides: Record<string, unknown> = {}) {
      return {
        id: "evt_refund",
        type: "charge.refunded",
        created: 1_700_000_100,
        data: {
          object: {
            id: "ch_1",
            payment_intent: "pi_1",
            ...overrides,
          },
        },
      };
    }

    const succeededRefund = {
      id: "re_1",
      status: "succeeded",
      amount: 1000,
      currency: "usd",
      created: 1_700_000_050,
    };

    it("records an external succeeded refund via record_refund_ledger and transitions the order to partially_refunded", async () => {
      h.constructEvent.mockReturnValue(chargeRefundedEvent());
      h.piLookup.mockResolvedValue({
        data: { id: "pi-row-1", shop_id: "shop-1", order_ref: "order-1", currency: "usd" },
        error: null,
      });
      h.refundsList.mockResolvedValue({ data: [succeededRefund] });
      h.rpc.mockResolvedValue({
        data: { captured_cents: 2500, refunded_cents: 1000, fully_refunded: false, inserted: true },
        error: null,
      });
      h.orderState = "paid";

      const res = await processStripeEvent("raw-body", "sig");

      expect(res).toEqual({ status: 200, processed: true, duplicate: false });
      expect(h.refundsList).toHaveBeenCalledWith({ charge: "ch_1", limit: 100 });
      expect(h.rpc).toHaveBeenCalledWith("record_refund_ledger", {
        p_shop_id: "shop-1",
        p_payment_intent_id: "pi-row-1",
        p_order_ref: "order-1",
        p_amount_cents: 1000,
        p_currency: "usd",
        p_stripe_ref: "ch_1",
        p_stripe_event_id: "re_1",
        p_occurred_at: new Date(succeededRefund.created * 1000).toISOString(),
      });
      expect(h.transitionOrder).toHaveBeenCalledWith("shop-1", "order-1", "partially_refunded", "stripe:charge.refunded");
      expect(h.ordersUpdate).toHaveBeenCalledWith({ financial_status: "partially_refunded" });
    });

    it("transitions to refunded when the RPC reports fully_refunded", async () => {
      h.constructEvent.mockReturnValue(chargeRefundedEvent());
      h.piLookup.mockResolvedValue({
        data: { id: "pi-row-1", shop_id: "shop-1", order_ref: "order-1", currency: "usd" },
        error: null,
      });
      h.refundsList.mockResolvedValue({ data: [succeededRefund] });
      h.rpc.mockResolvedValue({
        data: { captured_cents: 1000, refunded_cents: 1000, fully_refunded: true, inserted: true },
        error: null,
      });
      h.orderState = "paid";

      const res = await processStripeEvent("raw-body", "sig");

      expect(res).toEqual({ status: 200, processed: true, duplicate: false });
      expect(h.transitionOrder).toHaveBeenCalledWith("shop-1", "order-1", "refunded", "stripe:charge.refunded");
      expect(h.ordersUpdate).toHaveBeenCalledWith({ financial_status: "refunded" });
    });

    it("is a no-op (ACK duplicate) when the refund already landed via executeRefundAction (RPC replay, inserted:false)", async () => {
      h.constructEvent.mockReturnValue(chargeRefundedEvent());
      h.piLookup.mockResolvedValue({
        data: { id: "pi-row-1", shop_id: "shop-1", order_ref: "order-1", currency: "usd" },
        error: null,
      });
      h.refundsList.mockResolvedValue({ data: [succeededRefund] });
      h.rpc.mockResolvedValue({
        data: { captured_cents: 2500, refunded_cents: 1000, fully_refunded: false, inserted: false },
        error: null,
      });

      const res = await processStripeEvent("raw-body", "sig");

      expect(res).toEqual({ status: 200, processed: false, duplicate: true });
      expect(h.transitionOrder).not.toHaveBeenCalled();
      expect(h.ordersUpdate).not.toHaveBeenCalled();
    });

    it("ACKs and calls no RPC for a charge with no matching payment_intent row", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      h.constructEvent.mockReturnValue(chargeRefundedEvent());
      h.piLookup.mockResolvedValue({ data: null, error: null });

      const res = await processStripeEvent("raw-body", "sig");

      expect(res).toEqual({ status: 200, processed: false, duplicate: false });
      expect(h.rpc).not.toHaveBeenCalled();
      expect(h.refundsList).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/charge not originated by Calderyn/));
      warn.mockRestore();
    });

    it("does not re-transition when the order is already in the resolved state (identity move)", async () => {
      h.constructEvent.mockReturnValue(chargeRefundedEvent());
      h.piLookup.mockResolvedValue({
        data: { id: "pi-row-1", shop_id: "shop-1", order_ref: "order-1", currency: "usd" },
        error: null,
      });
      h.refundsList.mockResolvedValue({ data: [succeededRefund] });
      h.rpc.mockResolvedValue({
        data: { captured_cents: 1000, refunded_cents: 1000, fully_refunded: false, inserted: true },
        error: null,
      });
      h.orderState = "partially_refunded"; // already partially_refunded -> resolvedState is identical

      const res = await processStripeEvent("raw-body", "sig");

      expect(res).toEqual({ status: 200, processed: true, duplicate: false });
      expect(h.transitionOrder).not.toHaveBeenCalled();
      // The financial_status stamp is still applied (best-effort, mirrors executeRefundAction's tail).
      expect(h.ordersUpdate).toHaveBeenCalledWith({ financial_status: "partially_refunded" });
    });

    it("logs loudly and skips (never throws) an illegal transition, e.g. the order is still checkout_pending", async () => {
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      h.constructEvent.mockReturnValue(chargeRefundedEvent());
      h.piLookup.mockResolvedValue({
        data: { id: "pi-row-1", shop_id: "shop-1", order_ref: "order-1", currency: "usd" },
        error: null,
      });
      h.refundsList.mockResolvedValue({ data: [succeededRefund] });
      h.rpc.mockResolvedValue({
        data: { captured_cents: 1000, refunded_cents: 1000, fully_refunded: false, inserted: true },
        error: null,
      });
      h.orderState = "checkout_pending"; // checkout_pending -> partially_refunded is illegal

      const res = await processStripeEvent("raw-body", "sig");

      expect(res).toEqual({ status: 200, processed: true, duplicate: false });
      expect(h.transitionOrder).not.toHaveBeenCalled();
      expect(err).toHaveBeenCalledWith(expect.stringMatching(/cannot legally move to/));
      err.mockRestore();
    });

    it("warns and skips reconciliation (but keeps the ledger write) when the payment_intent has no order_ref", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      h.constructEvent.mockReturnValue(chargeRefundedEvent());
      h.piLookup.mockResolvedValue({
        data: { id: "pi-row-1", shop_id: "shop-1", order_ref: null, currency: "usd" },
        error: null,
      });
      h.refundsList.mockResolvedValue({ data: [succeededRefund] });
      h.rpc.mockResolvedValue({
        data: { captured_cents: 1000, refunded_cents: 1000, fully_refunded: false, inserted: true },
        error: null,
      });

      const res = await processStripeEvent("raw-body", "sig");

      expect(res).toEqual({ status: 200, processed: true, duplicate: false });
      expect(h.transitionOrder).not.toHaveBeenCalled();
      expect(h.ordersUpdate).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/no order_ref/));
      warn.mockRestore();
    });

    it("skips ignored (non-succeeded) refunds on the charge and treats an all-ignored list as a no-op ACK", async () => {
      h.constructEvent.mockReturnValue(chargeRefundedEvent());
      h.piLookup.mockResolvedValue({
        data: { id: "pi-row-1", shop_id: "shop-1", order_ref: "order-1", currency: "usd" },
        error: null,
      });
      h.refundsList.mockResolvedValue({ data: [{ ...succeededRefund, status: "pending" }] });

      const res = await processStripeEvent("raw-body", "sig");

      expect(res).toEqual({ status: 200, processed: false, duplicate: true });
      expect(h.rpc).not.toHaveBeenCalled();
      expect(h.transitionOrder).not.toHaveBeenCalled();
    });

    it("ACKs and calls no RPC when the charge carries no payment_intent at all", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      h.constructEvent.mockReturnValue({
        id: "evt_refund_no_pi",
        type: "charge.refunded",
        created: 1_700_000_100,
        data: { object: { id: "ch_2", payment_intent: null } },
      });

      const res = await processStripeEvent("raw-body", "sig");

      expect(res).toEqual({ status: 200, processed: false, duplicate: false });
      expect(h.piLookup).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/no payment_intent/));
      warn.mockRestore();
    });
  });

  describe("charge.dispute.created (dispute visibility)", () => {
    function disputeEvent(overrides: Record<string, unknown> = {}) {
      return {
        id: "evt_dispute",
        type: "charge.dispute.created",
        created: 1_700_000_200,
        data: {
          object: {
            id: "dp_1",
            payment_intent: "pi_1",
            amount: 2500,
            currency: "usd",
            reason: "fraudulent",
            ...overrides,
          },
        },
      };
    }

    it("logs loudly and stamps financial_status='disputed' for a dispute on our payment_intent", async () => {
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      h.constructEvent.mockReturnValue(disputeEvent());
      h.piLookup.mockResolvedValue({
        data: { id: "pi-row-1", shop_id: "shop-1", order_ref: "order-1", currency: "usd" },
        error: null,
      });

      const res = await processStripeEvent("raw-body", "sig");

      expect(res).toEqual({ status: 200, processed: true, duplicate: false });
      expect(err).toHaveBeenCalledWith(
        expect.stringMatching(/DISPUTE dp_1 on order order-1 \(shop shop-1\).*fraudulent/s),
      );
      expect(h.ordersUpdate).toHaveBeenCalledWith({ financial_status: "disputed" });
      expect(h.rpc).not.toHaveBeenCalled();
      expect(h.transitionOrder).not.toHaveBeenCalled();
      err.mockRestore();
    });

    it("ACKs (warn, no error log) for a dispute on a payment_intent we don't recognize", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      h.constructEvent.mockReturnValue(disputeEvent());
      h.piLookup.mockResolvedValue({ data: null, error: null });

      const res = await processStripeEvent("raw-body", "sig");

      expect(res).toEqual({ status: 200, processed: false, duplicate: false });
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/dispute not ours/));
      expect(err).not.toHaveBeenCalled();
      expect(h.ordersUpdate).not.toHaveBeenCalled();
      warn.mockRestore();
      err.mockRestore();
    });
  });
});
