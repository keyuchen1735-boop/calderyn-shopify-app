import { describe, it, expect, vi } from "vitest";

// Routing + fallback + decline semantics are unit-tested against
// createRoutedPaymentIntent in connect.server.test.ts; every test here doMocks
// that seam and asserts the ACP wiring — base params, row stamping, and that
// a charged-but-unpersisted PI can never return a false success (rule 12).
const platformResult = (pi: Record<string, unknown>) => ({
  pi,
  stripeAccountId: null,
  applicationFeeCents: null,
});

function mockSeam(impl: (shopId: string, base: Record<string, unknown>) => Promise<unknown>) {
  const routedCreate = vi.fn(impl);
  vi.doMock("~/lib/payments/connect.server", () => ({ createRoutedPaymentIntent: routedCreate }));
  return routedCreate;
}

describe("chargeSharedPaymentToken", () => {
  it("creates a confirmed PaymentIntent for the order total using the SPT as payment_method", async () => {
    vi.resetModules();
    const routedCreate = mockSeam(async () => platformResult({ id: "pi_1", status: "succeeded" }));
    const inserted: Record<string, unknown>[] = [];
    vi.doMock("~/lib/supabase.server", () => ({
      getSupabase: () => ({ from: () => ({ insert: async (row: Record<string, unknown>) => { inserted.push(row); return { error: null }; } }) }),
    }));
    const { chargeSharedPaymentToken } = await import("./charge.server");
    const res = await chargeSharedPaymentToken("shop_test", { orderId: "order1", totalCents: 2660, currency: "usd", sharedPaymentToken: "spt_123" });
    expect(res.status).toBe("succeeded");
    expect(routedCreate).toHaveBeenCalledWith(
      "shop_test",
      expect.objectContaining({ amount: 2660, currency: "usd", payment_method: "spt_123", confirm: true, off_session: true }),
      // The per-order idempotency key is what makes a retried ACP `complete`
      // reuse the PaymentIntent instead of double-charging the buyer.
      { logLabel: "ACP", idempotencyKey: "acp_charge_order1" },
    );
    expect((routedCreate.mock.calls[0][1] as { metadata: { order_ref: string } }).metadata.order_ref).toBe("order1");
    // Platform charge -> null routing stamps on the mirror row.
    expect(inserted[0]).toMatchObject({ stripe_account_id: null, application_fee_cents: null });
  });

  it("surfaces a declined charge (rule 12) rather than reporting success", async () => {
    vi.resetModules();
    mockSeam(async () => platformResult({ id: "pi_2", status: "requires_payment_method" }));
    vi.doMock("~/lib/supabase.server", () => ({
      getSupabase: () => ({ from: () => ({ insert: async () => ({ error: null }) }) }),
    }));
    const { chargeSharedPaymentToken } = await import("./charge.server");
    // LEARNING #3: prototype identity breaks across resetModules — assert on .code, not instanceof
    await expect(
      chargeSharedPaymentToken("shop_test", { orderId: "order1", totalCents: 2660, currency: "usd", sharedPaymentToken: "spt_bad" }),
    ).rejects.toMatchObject({ code: "CHARGE_DECLINED" });
  });

  it("stamps the routed acct + fee from the seam's outcome on the mirror row", async () => {
    vi.resetModules();
    mockSeam(async () => ({
      pi: { id: "pi_spt", status: "succeeded" },
      stripeAccountId: "acct_1",
      applicationFeeCents: 280,
    }));
    const inserted: Record<string, unknown>[] = [];
    vi.doMock("~/lib/supabase.server", () => ({
      getSupabase: () => ({ from: () => ({ insert: async (row: Record<string, unknown>) => { inserted.push(row); return { error: null }; } }) }),
    }));
    const { chargeSharedPaymentToken } = await import("./charge.server");
    await chargeSharedPaymentToken("shop_test", { orderId: "order9", totalCents: 5000, currency: "usd", sharedPaymentToken: "spt_1" });
    expect(inserted[0]).toMatchObject({ stripe_account_id: "acct_1", application_fee_cents: 280 });
  });

  it("propagates a seam rejection (e.g. card decline) without inserting a row", async () => {
    vi.resetModules();
    const routedCreate = mockSeam(async () => {
      throw Object.assign(new Error("card declined"), { type: "StripeCardError" });
    });
    const inserted: Record<string, unknown>[] = [];
    vi.doMock("~/lib/supabase.server", () => ({
      getSupabase: () => ({ from: () => ({ insert: async (row: Record<string, unknown>) => { inserted.push(row); return { error: null }; } }) }),
    }));
    const { chargeSharedPaymentToken } = await import("./charge.server");
    await expect(
      chargeSharedPaymentToken("shop_test", { orderId: "order9", totalCents: 5000, currency: "usd", sharedPaymentToken: "spt_1" }),
    ).rejects.toThrow(/card declined/);
    expect(routedCreate).toHaveBeenCalledTimes(1);
    expect(inserted).toHaveLength(0);
  });

  it("a failed mirror persist after a confirmed charge SURFACES — never a false success (rule 12)", async () => {
    vi.resetModules();
    mockSeam(async () => platformResult({ id: "pi_ok", status: "succeeded" }));
    vi.doMock("~/lib/supabase.server", () => ({
      getSupabase: () => ({ from: () => ({ insert: async () => ({ error: { message: "connection reset" } }) }) }),
    }));
    const { chargeSharedPaymentToken } = await import("./charge.server");
    await expect(
      chargeSharedPaymentToken("shop_test", { orderId: "order1", totalCents: 2660, currency: "usd", sharedPaymentToken: "spt_123" }),
    ).rejects.toMatchObject({ message: "connection reset" });
  });
});
