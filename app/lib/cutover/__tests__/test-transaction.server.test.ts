import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => ({
  getOrgMode: vi.fn(),
  getConnectedAccount: vi.fn(),
  createCommerceCheckoutSession: vi.fn(),
  upsertGuestBuyer: vi.fn(),
  insertReturn: vi.fn(),
}));

vi.mock("~/lib/cutover/org-mode.server", () => ({ getOrgMode: hoisted.getOrgMode }));
vi.mock("~/lib/payments/connect.server", () => ({ getConnectedAccount: hoisted.getConnectedAccount }));
vi.mock("~/lib/buyer/identity.server", () => ({ upsertGuestBuyer: hoisted.upsertGuestBuyer }));
vi.mock("~/lib/commerce/stripe-checkout.server", () => ({
  createCommerceCheckoutSession: hoisted.createCommerceCheckoutSession,
}));
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    from: () => ({
      insert: () => ({ select: () => ({ single: hoisted.insertReturn }) }),
    }),
  }),
}));

import { startTestTransaction, TEST_CHARGE_CENTS } from "../test-transaction.server";

describe("startTestTransaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.getOrgMode.mockResolvedValue("dual_run");
    hoisted.getConnectedAccount.mockResolvedValue({ id: "acct_1" });
    hoisted.upsertGuestBuyer.mockResolvedValue({ id: "buyer-1" });
    hoisted.insertReturn.mockResolvedValue({
      data: { id: "order-123", confirmation_token: "tok-abc" },
      error: null,
    });
    hoisted.createCommerceCheckoutSession.mockResolvedValue({ sessionId: "cs_1", url: "https://stripe/pay" });
  });

  it("originates a channel='test' order at the Stripe minimum and returns the checkout url", async () => {
    const res = await startTestTransaction("shop-1");
    expect(res.url).toBe("https://stripe/pay");
    expect(TEST_CHARGE_CENTS).toBe(50);
    expect(hoisted.createCommerceCheckoutSession).toHaveBeenCalledWith("shop-1", {
      orderId: "order-123",
      totalCents: 50,
      currency: "usd",
      confirmationToken: "tok-abc",
    });
  });

  it("rejects when the shop is not in dual_run", async () => {
    hoisted.getOrgMode.mockResolvedValue("mirror");
    await expect(startTestTransaction("shop-1")).rejects.toThrow(/dual_run/);
  });

  it("rejects with a clear message when Stripe is not connected", async () => {
    hoisted.getConnectedAccount.mockResolvedValue(null);
    await expect(startTestTransaction("shop-1")).rejects.toThrow(/Connect Stripe/i);
  });
});
