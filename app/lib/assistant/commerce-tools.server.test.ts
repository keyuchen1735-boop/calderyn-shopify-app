import { describe, it, expect, vi } from "vitest";

describe("commerce tool handlers", () => {
  it("place_order checks the spend cap then places the order and returns a pay URL", async () => {
    vi.resetModules();
    const calls: string[] = [];
    // place_order reads the locked quote to learn the total it must guard the cap against BEFORE
    // placing (rule 5). getQuote is the read; the cap/place/session steps are tracked in order.
    vi.doMock("~/lib/commerce/quote-store.server", () => ({
      getQuote: async () => ({ quoteId: "q1", totalCents: 2660, currency: "usd", expiresAt: "2999-01-01T00:00:00Z" }),
      lockQuote: async () => ({ quoteId: "q1", expiresAt: "2999-01-01T00:00:00Z" }),
    }));
    vi.doMock("~/lib/commerce/guardrail.server", () => ({ assertWithinCommerceCap: async () => { calls.push("cap"); } }));
    vi.doMock("~/lib/commerce/order.server", () => ({ placeAgenticOrder: async () => { calls.push("place"); return { orderId: "order1", confirmationToken: "tok", totalCents: 2660, currency: "usd" }; } }));
    vi.doMock("~/lib/commerce/stripe-checkout.server", () => ({ createCommerceCheckoutSession: async () => { calls.push("session"); return { sessionId: "cs_1", url: "https://stripe/cs_1" }; } }));
    vi.doMock("~/lib/payments/connect.server", () => ({ paymentsReadiness: async () => { calls.push("readiness"); return { ready: true, route: "destination" }; } }));
    const { handleCommerceTool } = await import("./commerce-tools.server");
    const res = await handleCommerceTool("place_order", { quote_id: "q1", email: "b@x.com" }, { shopId: "shop_test", clientId: "c1" });
    expect(calls).toEqual(["readiness", "cap", "place", "session"]); // readiness + cap BEFORE place (rule 5)
    expect(JSON.parse(res.content).pay_url).toBe("https://stripe/cs_1");
  });

  it("place_order refuses a shop that cannot accept payments BEFORE placing (no orphan order)", async () => {
    vi.resetModules();
    const calls: string[] = [];
    vi.doMock("~/lib/commerce/quote-store.server", () => ({
      getQuote: async () => ({ quoteId: "q1", totalCents: 2660, currency: "usd", expiresAt: "2999-01-01T00:00:00Z" }),
      lockQuote: async () => ({ quoteId: "q1", expiresAt: "2999-01-01T00:00:00Z" }),
    }));
    vi.doMock("~/lib/commerce/guardrail.server", () => ({ assertWithinCommerceCap: async () => { calls.push("cap"); } }));
    vi.doMock("~/lib/commerce/order.server", () => ({ placeAgenticOrder: async () => { calls.push("place"); return { orderId: "order1", confirmationToken: "tok", totalCents: 2660, currency: "usd" }; } }));
    vi.doMock("~/lib/commerce/stripe-checkout.server", () => ({ createCommerceCheckoutSession: async () => { calls.push("session"); return { sessionId: "cs_1", url: "u" }; } }));
    vi.doMock("~/lib/payments/connect.server", () => ({ paymentsReadiness: async () => ({ ready: false, reason: "no_account" }) }));
    const { handleCommerceTool } = await import("./commerce-tools.server");
    const res = await handleCommerceTool("place_order", { quote_id: "q1", email: "b@x.com" }, { shopId: "shop_test", clientId: "c1" });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content).code).toBe("PAYMENTS_NOT_READY");
    expect(calls).toEqual([]); // nothing placed — no orphan checkout_pending order
  });

  it("place_order rejects an expired/unknown quote before checking the cap or placing", async () => {
    vi.resetModules();
    const calls: string[] = [];
    vi.doMock("~/lib/commerce/quote-store.server", () => ({ getQuote: async () => null, lockQuote: async () => ({ quoteId: "q1", expiresAt: "x" }) }));
    vi.doMock("~/lib/commerce/guardrail.server", () => ({ assertWithinCommerceCap: async () => { calls.push("cap"); } }));
    vi.doMock("~/lib/commerce/order.server", () => ({ placeAgenticOrder: async () => { calls.push("place"); return { orderId: "order1", confirmationToken: "tok", totalCents: 0, currency: "usd" }; } }));
    vi.doMock("~/lib/commerce/stripe-checkout.server", () => ({ createCommerceCheckoutSession: async () => ({ sessionId: "cs_1", url: "u" }) }));
    const { handleCommerceTool } = await import("./commerce-tools.server");
    const res = await handleCommerceTool("place_order", { quote_id: "stale", email: "b@x.com" }, { shopId: "shop_test", clientId: "c1" });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content).code).toBe("QUOTE_EXPIRED");
    expect(calls).toEqual([]); // nothing placed/charged
  });
});
