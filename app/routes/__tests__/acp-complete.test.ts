import { describe, it, expect, vi } from "vitest";

describe("ACP complete action", () => {
  it("verifies signature, places the order, charges the SPT, returns the order (cap BEFORE charge)", async () => {
    vi.resetModules();
    process.env.ACP_ENABLED = "true";
    process.env.ACP_SIGNING_SECRET = "whsec_test";
    const order: string[] = [];
    vi.doMock("~/lib/commerce/acp/signature.server", () => ({ verifyAcpSignature: () => true }));
    vi.doMock("~/lib/commerce/acp/session-store.server", () => ({
      getAcpSession: async () => ({ sessionId: "acp_1", shopId: "shop_test", clientId: "c1", quoteId: "q1", orderId: null, status: "open" }),
      completeAcpSession: async () => { order.push("complete_session"); },
    }));
    vi.doMock("~/lib/commerce/quote-store.server", () => ({ getQuote: async () => ({ quoteId: "q1", totalCents: 2660, currency: "usd" }) }));
    vi.doMock("~/lib/commerce/guardrail.server", () => ({ assertWithinCommerceCap: async () => { order.push("cap"); } }));
    vi.doMock("~/lib/commerce/order.server", () => ({ placeAgenticOrder: async () => { order.push("place"); return { orderId: "order1", confirmationToken: "t", totalCents: 2660, currency: "usd" }; } }));
    vi.doMock("~/lib/commerce/acp/charge.server", () => ({ chargeSharedPaymentToken: async () => { order.push("charge"); return { paymentIntentId: "pi_1", status: "succeeded" }; } }));
    const { action } = await import("../acp.checkout_sessions.$id.complete");
    const req = new Request("https://app/acp/checkout_sessions/acp_1/complete", { method: "POST", body: JSON.stringify({ payment: { shared_payment_token: "spt_1" }, buyer: { email: "b@x.com" } }) });
    const res = await action({ request: req, params: { id: "acp_1" }, context: {} } as never);
    const data = await res.json() as Record<string, unknown>;
    expect(order).toEqual(["cap", "place", "charge", "complete_session"]); // cap precedes charge (rule 5)
    expect(data.order_id).toBe("order1");
  });
});
