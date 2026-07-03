import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({ refundCreate: vi.fn() }));

vi.mock("stripe", () => ({
  default: class {
    refunds = { create: h.refundCreate };
  },
}));

// eslint-disable-next-line import/first -- import must follow vi.mock so the Stripe fake registers first
import { createStripeRefund } from "./refund.server";

beforeEach(() => {
  vi.clearAllMocks();
  process.env.STRIPE_SECRET_KEY = "sk_test_x";
});

describe("createStripeRefund", () => {
  it("refunds a platform charge with no transfer-reversal params and passes the idempotency key", async () => {
    h.refundCreate.mockResolvedValue({ id: "re_1", status: "succeeded", charge: "ch_1" });
    const out = await createStripeRefund({
      paymentIntentId: "pi_1",
      amountCents: 2500,
      stripeAccountId: null,
      idempotencyKey: "k1",
    });
    expect(h.refundCreate).toHaveBeenCalledWith(
      { payment_intent: "pi_1", amount: 2500, reason: "requested_by_customer" },
      { idempotencyKey: "k1" },
    );
    expect(out).toEqual({ refundId: "re_1", status: "succeeded", chargeId: "ch_1" });
  });

  it("reverses the transfer + application fee for a destination-routed (connected-account) charge", async () => {
    h.refundCreate.mockResolvedValue({ id: "re_2", status: "pending", charge: { id: "ch_2" } });
    const out = await createStripeRefund({
      paymentIntentId: "pi_2",
      amountCents: 1000,
      stripeAccountId: "acct_9",
      idempotencyKey: "k2",
    });
    expect(h.refundCreate).toHaveBeenCalledWith(
      {
        payment_intent: "pi_2",
        amount: 1000,
        reason: "requested_by_customer",
        reverse_transfer: true,
        refund_application_fee: true,
      },
      { idempotencyKey: "k2" },
    );
    expect(out.chargeId).toBe("ch_2");
  });

  it("rejects a non-positive / non-integer amount at the boundary", async () => {
    await expect(
      createStripeRefund({ paymentIntentId: "pi_1", amountCents: 0, stripeAccountId: null, idempotencyKey: "k" }),
    ).rejects.toThrow(/positive integer/);
    await expect(
      createStripeRefund({ paymentIntentId: "pi_1", amountCents: 12.5, stripeAccountId: null, idempotencyKey: "k" }),
    ).rejects.toThrow(/positive integer/);
    expect(h.refundCreate).not.toHaveBeenCalled();
  });
});
