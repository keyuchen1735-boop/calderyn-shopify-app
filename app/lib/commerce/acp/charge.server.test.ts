import { describe, it, expect, vi } from "vitest";

describe("chargeSharedPaymentToken", () => {
  it("creates a confirmed PaymentIntent for the order total using the SPT as payment_method", async () => {
    vi.resetModules();
    const created: Record<string, unknown>[] = [];
    vi.doMock("~/lib/payments/stripe.server", () => ({
      getStripe: () => ({ paymentIntents: { create: async (a: Record<string, unknown>) => { created.push(a); return { id: "pi_1", status: "succeeded" }; } } }),
    }));
    vi.doMock("~/lib/supabase.server", () => ({
      getSupabase: () => ({ from: () => ({ insert: async () => ({ error: null }) }) }),
    }));
    const { chargeSharedPaymentToken } = await import("./charge.server");
    const res = await chargeSharedPaymentToken("shop_test", { orderId: "order1", totalCents: 2660, currency: "usd", sharedPaymentToken: "spt_123" });
    expect(res.status).toBe("succeeded");
    expect(created[0]).toMatchObject({ amount: 2660, currency: "usd", payment_method: "spt_123", confirm: true });
    expect((created[0] as { metadata: { order_ref: string } }).metadata.order_ref).toBe("order1");
  });

  it("surfaces a declined charge (rule 12) rather than reporting success", async () => {
    vi.resetModules();
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
});
