import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => ({
  sessionsCreate: vi.fn(),
  destinationParamsFor: vi.fn(),
}));
vi.mock("~/lib/payments/stripe.server", () => ({
  getStripe: () => ({ checkout: { sessions: { create: hoisted.sessionsCreate } } }),
}));
// The routing decision itself (fail-closed, demo exemption, fee math) is tested in
// connect.server.test.ts; here we assert the session WIRES whatever it decides.
vi.mock("~/lib/payments/connect.server", () => ({
  destinationParamsFor: hoisted.destinationParamsFor,
}));

// eslint-disable-next-line import/first -- import must follow vi.mock so the fakes register first
import { createCommerceCheckoutSession } from "../stripe-checkout.server";

describe("createCommerceCheckoutSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("STOREFRONT_BASE_URL", "https://shop.example");
    hoisted.sessionsCreate.mockResolvedValue({ id: "cs_1", url: "https://stripe/pay" });
    // Default: demo/platform decision — no connect params attached.
    hoisted.destinationParamsFor.mockResolvedValue({ params: {}, stripeAccountId: null, applicationFeeCents: null });
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

  it("attaches the destination-charge params to payment_intent_data so the money routes to the merchant", async () => {
    hoisted.destinationParamsFor.mockResolvedValue({
      params: {
        transfer_data: { destination: "acct_1" },
        on_behalf_of: "acct_1",
        application_fee_amount: 42,
      },
      stripeAccountId: "acct_1",
      applicationFeeCents: 42,
    });

    await createCommerceCheckoutSession("shop-1", {
      orderId: "order-1",
      totalCents: 500,
      currency: "usd",
      confirmationToken: "tok-abc",
    });

    expect(hoisted.destinationParamsFor).toHaveBeenCalledWith("shop-1", 500, undefined);
    const args = hoisted.sessionsCreate.mock.calls[0][0];
    expect(args.payment_intent_data).toEqual({
      metadata: { shop_id: "shop-1", order_ref: "order-1" },
      transfer_data: { destination: "acct_1" },
      on_behalf_of: "acct_1",
      application_fee_amount: 42,
    });
  });

  it("propagates PaymentsNotReadyError from the routing decision (no session for an unpayable shop)", async () => {
    hoisted.destinationParamsFor.mockRejectedValue(Object.assign(new Error("not ready"), { code: "PAYMENTS_NOT_READY" }));
    await expect(
      createCommerceCheckoutSession("shop-1", {
        orderId: "order-1",
        totalCents: 500,
        currency: "usd",
        confirmationToken: "tok-abc",
      }),
    ).rejects.toMatchObject({ code: "PAYMENTS_NOT_READY" });
    expect(hoisted.sessionsCreate).not.toHaveBeenCalled();
  });
});
