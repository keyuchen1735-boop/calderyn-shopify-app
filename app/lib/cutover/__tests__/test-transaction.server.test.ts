import { describe, it, expect, vi, beforeEach } from "vitest";

import { startTestTransaction, TEST_CHARGE_CENTS , refundTestOrders } from "../test-transaction.server";


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

const refundHoisted = vi.hoisted(() => ({
  executeRefundAction: vi.fn(),
}));
vi.mock("~/lib/actions/refund.server", () => ({ executeRefundAction: refundHoisted.executeRefundAction }));

describe("refundTestOrders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    refundHoisted.executeRefundAction.mockResolvedValue({ outcome: "succeeded" });
  });

  // Supabase seam: getSupabase().from('orders').select().eq().eq() resolves to paid test orders.
  function stubSupabaseWith(rows: Array<{ id: string }>) {
    const eq2 = () => Promise.resolve({ data: rows, error: null });
    const eq1 = () => ({ eq: eq2 });
    return { from: () => ({ select: () => ({ eq: eq1 }) }) };
  }

  it("full-refunds every paid channel='test' order", async () => {
    const sb = stubSupabaseWith([{ id: "o1" }, { id: "o2" }]) as never;
    await refundTestOrders("shop-1", sb);
    expect(refundHoisted.executeRefundAction).toHaveBeenCalledTimes(2);
    expect(refundHoisted.executeRefundAction.mock.calls[0][1]).toMatchObject({ orderId: "o1" });
  });

  it("logs loudly and does NOT throw when a refund fails (cutover already committed)", async () => {
    const sb = stubSupabaseWith([{ id: "o1" }]) as never;
    refundHoisted.executeRefundAction.mockRejectedValueOnce(new Error("stripe down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(refundTestOrders("shop-1", sb)).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
