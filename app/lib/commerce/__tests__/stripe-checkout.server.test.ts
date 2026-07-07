import { describe, it, expect, vi, beforeEach } from "vitest";

import { createCommerceCheckoutSession } from "../stripe-checkout.server";

const hoisted = vi.hoisted(() => ({
  sessionsCreate: vi.fn(),
}));
vi.mock("~/lib/payments/stripe.server", () => ({
  getStripe: () => ({ checkout: { sessions: { create: hoisted.sessionsCreate } } }),
}));

describe("createCommerceCheckoutSession return URLs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("STOREFRONT_BASE_URL", "https://shop.example");
    hoisted.sessionsCreate.mockResolvedValue({ id: "cs_1", url: "https://stripe/pay" });
  });

  it("defaults to the buyer storefront confirmation/cart pages", async () => {
    await createCommerceCheckoutSession("shop-1", {
      orderId: "order-1",
      totalCents: 500,
      currency: "usd",
      confirmationToken: "tok-abc",
    });
    const args = hoisted.sessionsCreate.mock.calls[0][0];
    expect(args.success_url).toBe("https://shop.example/storefront/checkout/confirmation/tok-abc");
    expect(args.cancel_url).toBe("https://shop.example/storefront/cart");
  });

  it("honors an explicit returnUrls override (merchant-facing flows)", async () => {
    await createCommerceCheckoutSession("shop-1", {
      orderId: "order-1",
      totalCents: 50,
      currency: "usd",
      confirmationToken: "tok-abc",
      returnUrls: {
        success: "https://app.example/dashboard/settings/golive?test_tx=success",
        cancel: "https://app.example/dashboard/settings/golive?test_tx=cancelled",
      },
    });
    const args = hoisted.sessionsCreate.mock.calls[0][0];
    expect(args.success_url).toBe("https://app.example/dashboard/settings/golive?test_tx=success");
    expect(args.cancel_url).toBe("https://app.example/dashboard/settings/golive?test_tx=cancelled");
  });
});
