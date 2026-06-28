import { describe, it, expect, beforeEach, vi } from "vitest";

// Hoisted mock handles shared by the Stripe SDK + Supabase mocks below.
const h = vi.hoisted(() => ({
  piCreate: vi.fn(),
  constructEvent: vi.fn(),
  insert: vi.fn(),
  rpc: vi.fn(),
}));

// Server SDK: default export is the Stripe class; instances expose paymentIntents + webhooks.
vi.mock("stripe", () => ({
  default: class {
    paymentIntents = { create: h.piCreate };
    webhooks = { constructEvent: h.constructEvent };
  },
}));

// Service-role Supabase client.
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    from: () => ({ insert: h.insert }),
    rpc: h.rpc,
  }),
}));

// eslint-disable-next-line import/first -- import must follow vi.mock so the stripe + supabase fakes are registered before the module under test loads
import { createPaymentIntent, processStripeEvent } from "./stripe.server";

beforeEach(() => {
  vi.clearAllMocks();
  process.env.STRIPE_SECRET_KEY = "sk_test_x";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
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
});
