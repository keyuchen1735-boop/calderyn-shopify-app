import { describe, it, expect, vi } from "vitest";

describe("calculateTax", () => {
  it("returns Stripe's computed tax in integer cents", async () => {
    vi.resetModules();
    vi.doMock("~/lib/payments/stripe.server", () => ({
      getStripe: () => ({
        tax: { calculations: { create: async () => ({ tax_amount_exclusive: 73 }) } },
      }),
    }));
    const { calculateTax } = await import("./tax.server");
    const cents = await calculateTax({
      currency: "usd",
      subtotalCents: 1000,
      shippingCents: 500,
      destination: { street1: "1 A St", city: "Denver", state: "CO", zip: "80202", country: "US" },
    });
    expect(cents).toBe(73);
  });
});
