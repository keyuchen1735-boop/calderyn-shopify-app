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

  it("quotes $0 tax (loudly) when Stripe Tax is not activated — a config gap must not kill checkout", async () => {
    vi.resetModules();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.doMock("~/lib/payments/stripe.server", () => ({
      getStripe: () => ({
        tax: {
          calculations: {
            create: async () => {
              throw Object.assign(new Error("Stripe Tax has not been activated"), {
                code: "stripe_tax_inactive",
              });
            },
          },
        },
      }),
    }));
    const { calculateTax } = await import("./tax.server");
    const cents = await calculateTax({
      currency: "usd",
      subtotalCents: 1000,
      shippingCents: 500,
      destination: { street1: "1 A St", city: "Denver", state: "CO", zip: "80202", country: "US" },
    });
    expect(cents).toBe(0);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("Stripe Tax is not activated"));
    spy.mockRestore();
  });

  it("still fails the quote on any OTHER Stripe error (never silently zero a real failure)", async () => {
    vi.resetModules();
    vi.doMock("~/lib/payments/stripe.server", () => ({
      getStripe: () => ({
        tax: {
          calculations: {
            create: async () => {
              throw Object.assign(new Error("rate limited"), { code: "rate_limit" });
            },
          },
        },
      }),
    }));
    const { calculateTax } = await import("./tax.server");
    await expect(
      calculateTax({
        currency: "usd",
        subtotalCents: 1000,
        shippingCents: 500,
        destination: { street1: "1 A St", city: "Denver", state: "CO", zip: "80202", country: "US" },
      }),
    ).rejects.toThrow("rate limited");
  });
});
