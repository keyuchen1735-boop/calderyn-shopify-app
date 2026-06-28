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

import { createPaymentIntent } from "./stripe.server";

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
