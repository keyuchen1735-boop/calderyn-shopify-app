import { describe, it, expect, vi } from "vitest";

describe("createCommerceCheckoutSession", () => {
  it("creates a Stripe Checkout Session for the order total and returns its URL", async () => {
    vi.resetModules();
    const created: Record<string, unknown>[] = [];
    vi.doMock("~/lib/payments/stripe.server", () => ({
      getStripe: () => ({ checkout: { sessions: { create: async (a: Record<string, unknown>) => { created.push(a); return { id: "cs_1", url: "https://stripe/cs_1" }; } } } }),
    }));
    const { createCommerceCheckoutSession } = await import("./stripe-checkout.server");
    const res = await createCommerceCheckoutSession("shop_test", { orderId: "order1", totalCents: 2660, currency: "usd", confirmationToken: "tok" });
    expect(res.url).toBe("https://stripe/cs_1");
    expect((created[0] as { mode: string }).mode).toBe("payment");
    expect((created[0] as { metadata: { order_ref: string } }).metadata.order_ref).toBe("order1");
  });
});
