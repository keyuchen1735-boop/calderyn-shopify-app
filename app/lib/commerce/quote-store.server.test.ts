import { describe, it, expect, vi } from "vitest";

const QUOTE = {
  lines: [{ variantId: "V1", quantity: 1, unitPriceCents: 1000, currency: "usd", titleSnapshot: "Widget" }],
  subtotalCents: 1000, shippingCents: 500, taxCents: 80, totalCents: 1580, currency: "usd",
  deliveryEarliest: null, deliveryLatest: null, lowConfidence: false, fallbackUsed: false,
};

describe("quote-store", () => {
  it("lockQuote persists a row and returns a quoteId + expiry", async () => {
    vi.resetModules();
    const inserted: Record<string, unknown>[] = [];
    vi.doMock("~/lib/supabase.server", () => ({
      getSupabase: () => ({
        from: () => ({
          insert: (row: Record<string, unknown>) => { inserted.push(row); return { select: () => ({ single: async () => ({ data: { quote_id: "q1", expires_at: row.expires_at }, error: null }) }) }; },
        }),
      }),
    }));
    const { lockQuote } = await import("./quote-store.server");
    const res = await lockQuote("shop_test", QUOTE, { clientId: "c1", destinationHash: "dh" });
    expect(res.quoteId).toBe("q1");
    expect(inserted[0].total_cents).toBe(1580);
    expect(inserted[0].shop_id).toBe("shop_test");
  });

  it("getQuote returns null for an expired row (caller must re-quote)", async () => {
    vi.resetModules();
    const past = new Date(Date.parse("2000-01-01")).toISOString();
    vi.doMock("~/lib/supabase.server", () => ({
      getSupabase: () => ({ from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { quote_id: "q1", expires_at: past, total_cents: 1580 }, error: null }) }) }) }) }) }),
    }));
    const { getQuote } = await import("./quote-store.server");
    const res = await getQuote("shop_test", "q1");
    expect(res).toBeNull();
  });
});
