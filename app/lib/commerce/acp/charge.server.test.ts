import { describe, it, expect, vi } from "vitest";

// Every test doMocks connect.server: the routing DECISION is unit-tested in
// connect.server.test.ts; here we assert the wiring (spread, stamping, fallback).
const platformDecision = { params: {}, stripeAccountId: null, applicationFeeCents: null };
const destinationDecision = {
  params: { transfer_data: { destination: "acct_1" }, on_behalf_of: "acct_1" },
  stripeAccountId: "acct_1",
  applicationFeeCents: null,
};

function mockConnect(decision: typeof platformDecision | typeof destinationDecision) {
  const syncAccountStatus = vi.fn(async () => null);
  vi.doMock("~/lib/payments/connect.server", () => ({
    destinationParamsFor: async () => decision,
    syncAccountStatus,
  }));
  return { syncAccountStatus };
}

describe("chargeSharedPaymentToken", () => {
  it("creates a confirmed PaymentIntent for the order total using the SPT as payment_method", async () => {
    vi.resetModules();
    mockConnect(platformDecision);
    const created: Record<string, unknown>[] = [];
    const inserted: Record<string, unknown>[] = [];
    vi.doMock("~/lib/payments/stripe.server", () => ({
      getStripe: () => ({ paymentIntents: { create: async (a: Record<string, unknown>) => { created.push(a); return { id: "pi_1", status: "succeeded" }; } } }),
    }));
    vi.doMock("~/lib/supabase.server", () => ({
      getSupabase: () => ({ from: () => ({ insert: async (row: Record<string, unknown>) => { inserted.push(row); return { error: null }; } }) }),
    }));
    const { chargeSharedPaymentToken } = await import("./charge.server");
    const res = await chargeSharedPaymentToken("shop_test", { orderId: "order1", totalCents: 2660, currency: "usd", sharedPaymentToken: "spt_123" });
    expect(res.status).toBe("succeeded");
    expect(created[0]).toMatchObject({ amount: 2660, currency: "usd", payment_method: "spt_123", confirm: true });
    expect((created[0] as { metadata: { order_ref: string } }).metadata.order_ref).toBe("order1");
    // Platform charge -> null routing stamps on the mirror row.
    expect(inserted[0]).toMatchObject({ stripe_account_id: null, application_fee_cents: null });
  });

  it("surfaces a declined charge (rule 12) rather than reporting success", async () => {
    vi.resetModules();
    mockConnect(platformDecision);
    vi.doMock("~/lib/payments/stripe.server", () => ({
      getStripe: () => ({ paymentIntents: { create: async () => ({ id: "pi_2", status: "requires_payment_method" }) } }),
    }));
    vi.doMock("~/lib/supabase.server", () => ({
      getSupabase: () => ({ from: () => ({ insert: async () => ({ error: null }) }) }),
    }));
    const { chargeSharedPaymentToken } = await import("./charge.server");
    // LEARNING #3: prototype identity breaks across resetModules — assert on .code, not instanceof
    await expect(
      chargeSharedPaymentToken("shop_test", { orderId: "order1", totalCents: 2660, currency: "usd", sharedPaymentToken: "spt_bad" }),
    ).rejects.toMatchObject({ code: "CHARGE_DECLINED" });
  });

  it("spreads destination params into the SPT charge and stamps the routed acct on the row", async () => {
    vi.resetModules();
    mockConnect(destinationDecision);
    const created: Record<string, unknown>[] = [];
    const inserted: Record<string, unknown>[] = [];
    vi.doMock("~/lib/payments/stripe.server", () => ({
      getStripe: () => ({ paymentIntents: { create: async (a: Record<string, unknown>) => { created.push(a); return { id: "pi_spt", status: "succeeded" }; } } }),
    }));
    vi.doMock("~/lib/supabase.server", () => ({
      getSupabase: () => ({ from: () => ({ insert: async (row: Record<string, unknown>) => { inserted.push(row); return { error: null }; } }) }),
    }));
    const { chargeSharedPaymentToken } = await import("./charge.server");
    await chargeSharedPaymentToken("shop_test", { orderId: "order9", totalCents: 5000, currency: "usd", sharedPaymentToken: "spt_1" });
    expect(created[0]).toMatchObject({
      transfer_data: { destination: "acct_1" },
      on_behalf_of: "acct_1",
      payment_method: "spt_1",
      confirm: true,
    });
    expect(inserted[0]).toMatchObject({ stripe_account_id: "acct_1", application_fee_cents: null });
  });

  it("a card DECLINE (confirm:true) is NOT retried as a platform charge — declines propagate", async () => {
    vi.resetModules();
    mockConnect(destinationDecision);
    const create = vi.fn(async () => {
      throw Object.assign(new Error("card declined"), { type: "StripeCardError" });
    });
    vi.doMock("~/lib/payments/stripe.server", () => ({ getStripe: () => ({ paymentIntents: { create } }) }));
    vi.doMock("~/lib/supabase.server", () => ({
      getSupabase: () => ({ from: () => ({ insert: async () => ({ error: null }) }) }),
    }));
    const { chargeSharedPaymentToken } = await import("./charge.server");
    await expect(
      chargeSharedPaymentToken("shop_test", { orderId: "order9", totalCents: 5000, currency: "usd", sharedPaymentToken: "spt_1" }),
    ).rejects.toThrow(/card declined/);
    expect(create).toHaveBeenCalledTimes(1); // NEVER double-attempt a confirmed charge on a decline
  });

  it("falls back to platform on a destination-invalid rejection", async () => {
    vi.resetModules();
    const { syncAccountStatus } = mockConnect(destinationDecision);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const created: Record<string, unknown>[] = [];
    const inserted: Record<string, unknown>[] = [];
    let calls = 0;
    vi.doMock("~/lib/payments/stripe.server", () => ({
      getStripe: () => ({
        paymentIntents: {
          create: async (a: Record<string, unknown>) => {
            calls += 1;
            if (calls === 1) throw Object.assign(new Error("no transfers"), { type: "StripeInvalidRequestError" });
            created.push(a);
            return { id: "pi_fb", status: "succeeded" };
          },
        },
      }),
    }));
    vi.doMock("~/lib/supabase.server", () => ({
      getSupabase: () => ({ from: () => ({ insert: async (row: Record<string, unknown>) => { inserted.push(row); return { error: null }; } }) }),
    }));
    const { chargeSharedPaymentToken } = await import("./charge.server");
    const out = await chargeSharedPaymentToken("shop_test", { orderId: "order9", totalCents: 5000, currency: "usd", sharedPaymentToken: "spt_1" });
    expect(out.paymentIntentId).toBe("pi_fb");
    expect(created[0]).not.toHaveProperty("transfer_data");
    expect(inserted[0]).toMatchObject({ stripe_account_id: null, application_fee_cents: null });
    expect(syncAccountStatus).toHaveBeenCalledWith("shop_test");
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/falling back to platform charge/));
    warn.mockRestore();
  });
});
