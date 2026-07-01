import { describe, it, expect, vi } from "vitest";

const LOCKED = {
  quoteId: "q1",
  lines: [{ variantId: "V1", quantity: 2, unitPriceCents: 1000, currency: "usd", titleSnapshot: "Widget" }],
  subtotalCents: 2000, shippingCents: 500, taxCents: 160, totalCents: 2660, currency: "usd",
  deliveryEarliest: null, deliveryLatest: null, lowConfidence: false, fallbackUsed: false, expiresAt: "2999-01-01T00:00:00Z",
};

function mock(insertedOrder: Record<string, unknown>[]) {
  vi.doMock("./quote-store.server", () => ({ getQuote: async () => LOCKED }));
  vi.doMock("~/lib/buyer/identity.server", () => ({
    upsertGuestBuyer: async () => ({ id: "buyer1" }), addBuyerAddress: async () => {}, recordCheckoutConsent: async () => {},
  }));
  vi.doMock("~/lib/supabase.server", () => ({
    getSupabase: () => ({
      from: (t: string) => ({
        insert: (row: Record<string, unknown>) => {
          if (t === "orders") { insertedOrder.push(row); return { select: () => ({ single: async () => ({ data: { id: "order1" }, error: null }) }) }; }
          return { error: null };
        },
      }),
    }),
  }));
}

describe("placeAgenticOrder", () => {
  it("creates a checkout_pending order tagged channel=agentic with the locked totals", async () => {
    vi.resetModules();
    const inserted: Record<string, unknown>[] = [];
    mock(inserted);
    const { placeAgenticOrder } = await import("./order.server");
    const res = await placeAgenticOrder("shop_test", "q1", { email: "b@x.com" }, { protocol: "mcp", clientId: "c1" });
    expect(res.orderId).toBe("order1");
    expect(inserted[0]).toMatchObject({ channel: "agentic", protocol: "mcp", client_id: "c1", total_cents: 2660, shipping_cents: 500, tax_cents: 160 });
  });

  it("rejects an expired/unknown quote (getQuote null) before any write", async () => {
    vi.resetModules();
    vi.doMock("./quote-store.server", () => ({ getQuote: async () => null }));
    const { placeAgenticOrder } = await import("./order.server");
    await expect(placeAgenticOrder("shop_test", "stale", { email: "b@x.com" }, { protocol: "mcp", clientId: "c1" }))
      .rejects.toMatchObject({ code: "QUOTE_EXPIRED" });
  });
});
