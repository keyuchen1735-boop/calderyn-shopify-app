import { describe, it, expect, vi } from "vitest";

const SUPPORTED = new Set(["usd", "eur", "gbp", "cad", "aud"]);

describe("ACP complete action", () => {
  it("verifies signature, places the order, charges the SPT, returns the order (cap BEFORE charge)", async () => {
    vi.resetModules();
    process.env.ACP_ENABLED = "true";
    process.env.ACP_SIGNING_SECRET = "whsec_test";
    const order: string[] = [];
    vi.doMock("~/lib/commerce/acp/signature.server", () => ({ verifyAcpSignature: () => true }));
    vi.doMock("~/lib/commerce/acp/session-store.server", () => ({
      getAcpSession: async () => ({ sessionId: "acp_1", shopId: "shop_test", clientId: "c1", quoteId: "q1", orderId: null, status: "open" }),
      claimAcpSessionForCompletion: async () => true,
      releaseAcpSessionClaim: async () => {},
      completeAcpSession: async () => { order.push("complete_session"); },
    }));
    vi.doMock("~/lib/commerce/quote-store.server", () => ({ getQuote: async () => ({ quoteId: "q1", totalCents: 2660, currency: "usd" }) }));
    vi.doMock("~/lib/payments/stripe.server", () => ({ isSupportedCurrency: (c: string) => SUPPORTED.has(c.toLowerCase()) }));
    vi.doMock("~/lib/commerce/guardrail.server", () => ({ assertWithinCommerceCap: async () => { order.push("cap"); } }));
    vi.doMock("~/lib/commerce/order.server", () => ({ placeAgenticOrder: async () => { order.push("place"); return { orderId: "order1", confirmationToken: "t", totalCents: 2660, currency: "usd" }; } }));
    vi.doMock("~/lib/commerce/acp/charge.server", () => ({ chargeSharedPaymentToken: async () => { order.push("charge"); return { paymentIntentId: "pi_1", status: "succeeded" }; } }));
    vi.doMock("~/lib/payments/connect.server", () => ({ paymentsReadiness: async () => ({ ready: true, route: "destination" }) }));
    const { action } = await import("../acp.checkout_sessions.$id.complete");
    const req = new Request("https://app/acp/checkout_sessions/acp_1/complete", { method: "POST", body: JSON.stringify({ payment: { shared_payment_token: "spt_1" }, buyer: { email: "b@x.com" } }) });
    const res = await action({ request: req, params: { id: "acp_1" }, context: {} } as never);
    const data = await res.json() as Record<string, unknown>;
    expect(order).toEqual(["cap", "place", "charge", "complete_session"]); // cap precedes charge (rule 5)
    expect(data.order_id).toBe("order1");
  });

  it("rejects an unsupported currency before claiming or placing (no orphan order)", async () => {
    vi.resetModules();
    process.env.ACP_ENABLED = "true";
    process.env.ACP_SIGNING_SECRET = "whsec_test";
    const claim = vi.fn(async () => true);
    const place = vi.fn();
    vi.doMock("~/lib/commerce/acp/signature.server", () => ({ verifyAcpSignature: () => true }));
    vi.doMock("~/lib/commerce/acp/session-store.server", () => ({
      getAcpSession: async () => ({ sessionId: "acp_1", shopId: "shop_test", clientId: "c1", quoteId: "q1", orderId: null, status: "open" }),
      claimAcpSessionForCompletion: claim,
      releaseAcpSessionClaim: async () => {},
      completeAcpSession: async () => {},
    }));
    vi.doMock("~/lib/commerce/quote-store.server", () => ({ getQuote: async () => ({ quoteId: "q1", totalCents: 2660, currency: "zzz" }) }));
    vi.doMock("~/lib/payments/stripe.server", () => ({ isSupportedCurrency: (c: string) => SUPPORTED.has(c.toLowerCase()) }));
    vi.doMock("~/lib/commerce/guardrail.server", () => ({ assertWithinCommerceCap: async () => {} }));
    vi.doMock("~/lib/commerce/order.server", () => ({ placeAgenticOrder: place }));
    vi.doMock("~/lib/commerce/acp/charge.server", () => ({ chargeSharedPaymentToken: async () => ({ paymentIntentId: "pi_1", status: "succeeded" }) }));
    const { action } = await import("../acp.checkout_sessions.$id.complete");
    const req = new Request("https://app/acp/checkout_sessions/acp_1/complete", { method: "POST", body: JSON.stringify({ payment: { shared_payment_token: "spt_1" }, buyer: { email: "b@x.com" } }) });
    const res = await action({ request: req, params: { id: "acp_1" }, context: {} } as never);
    expect(res.status).toBe(400);
    expect(claim).not.toHaveBeenCalled();
    expect(place).not.toHaveBeenCalled();
  });

  it("releases the claim when placing fails before any charge (so a transient blip is retryable)", async () => {
    vi.resetModules();
    process.env.ACP_ENABLED = "true";
    process.env.ACP_SIGNING_SECRET = "whsec_test";
    const release = vi.fn(async () => {});
    const charge = vi.fn();
    vi.doMock("~/lib/commerce/acp/signature.server", () => ({ verifyAcpSignature: () => true }));
    vi.doMock("~/lib/commerce/acp/session-store.server", () => ({
      getAcpSession: async () => ({ sessionId: "acp_1", shopId: "shop_test", clientId: "c1", quoteId: "q1", orderId: null, status: "open" }),
      claimAcpSessionForCompletion: async () => true,
      releaseAcpSessionClaim: release,
      completeAcpSession: async () => {},
    }));
    vi.doMock("~/lib/commerce/quote-store.server", () => ({ getQuote: async () => ({ quoteId: "q1", totalCents: 2660, currency: "usd" }) }));
    vi.doMock("~/lib/payments/stripe.server", () => ({ isSupportedCurrency: (c: string) => SUPPORTED.has(c.toLowerCase()) }));
    vi.doMock("~/lib/commerce/guardrail.server", () => ({ assertWithinCommerceCap: async () => {} }));
    vi.doMock("~/lib/commerce/order.server", () => ({ placeAgenticOrder: async () => { throw new Error("transient place failure"); } }));
    vi.doMock("~/lib/commerce/acp/charge.server", () => ({ chargeSharedPaymentToken: charge }));
    vi.doMock("~/lib/payments/connect.server", () => ({ paymentsReadiness: async () => ({ ready: true, route: "destination" }) }));
    const { action } = await import("../acp.checkout_sessions.$id.complete");
    const req = new Request("https://app/acp/checkout_sessions/acp_1/complete", { method: "POST", body: JSON.stringify({ payment: { shared_payment_token: "spt_1" }, buyer: { email: "b@x.com" } }) });
    await expect(action({ request: req, params: { id: "acp_1" }, context: {} } as never)).rejects.toThrow("transient place failure");
    expect(release).toHaveBeenCalledWith("acp_1"); // claim released so a retry can re-claim
    expect(charge).not.toHaveBeenCalled(); // no money moved
  });

  it("refuses an unpayable shop BEFORE claiming or placing (503 payments_not_ready, retryable)", async () => {
    vi.resetModules();
    process.env.ACP_ENABLED = "true";
    process.env.ACP_SIGNING_SECRET = "whsec_test";
    const claim = vi.fn(async () => true);
    const place = vi.fn();
    vi.doMock("~/lib/commerce/acp/signature.server", () => ({ verifyAcpSignature: () => true }));
    vi.doMock("~/lib/commerce/acp/session-store.server", () => ({
      getAcpSession: async () => ({ sessionId: "acp_1", shopId: "shop_test", clientId: "c1", quoteId: "q1", orderId: null, status: "open" }),
      claimAcpSessionForCompletion: claim,
      releaseAcpSessionClaim: async () => {},
      completeAcpSession: async () => {},
    }));
    vi.doMock("~/lib/commerce/quote-store.server", () => ({ getQuote: async () => ({ quoteId: "q1", totalCents: 2660, currency: "usd" }) }));
    vi.doMock("~/lib/payments/stripe.server", () => ({ isSupportedCurrency: (c: string) => SUPPORTED.has(c.toLowerCase()) }));
    vi.doMock("~/lib/commerce/guardrail.server", () => ({ assertWithinCommerceCap: async () => {} }));
    vi.doMock("~/lib/commerce/order.server", () => ({ placeAgenticOrder: place }));
    vi.doMock("~/lib/commerce/acp/charge.server", () => ({ chargeSharedPaymentToken: async () => ({ paymentIntentId: "pi_1", status: "succeeded" }) }));
    vi.doMock("~/lib/payments/connect.server", () => ({ paymentsReadiness: async () => ({ ready: false, reason: "onboarding_incomplete" }) }));
    const { action } = await import("../acp.checkout_sessions.$id.complete");
    const req = new Request("https://app/acp/checkout_sessions/acp_1/complete", { method: "POST", body: JSON.stringify({ payment: { shared_payment_token: "spt_1" }, buyer: { email: "b@x.com" } }) });
    const res = await action({ request: req, params: { id: "acp_1" }, context: {} } as never);
    expect(res.status).toBe(503);
    expect(((await res.json()) as Record<string, unknown>).error).toBe("payments_not_ready");
    expect(claim).not.toHaveBeenCalled(); // session never wedged
    expect(place).not.toHaveBeenCalled(); // no orphan order
  });

  it("releases the claim and returns 503 when the charge itself fails closed (pre-authorization, no money moved)", async () => {
    vi.resetModules();
    process.env.ACP_ENABLED = "true";
    process.env.ACP_SIGNING_SECRET = "whsec_test";
    const release = vi.fn(async () => {});
    const complete = vi.fn();
    vi.doMock("~/lib/commerce/acp/signature.server", () => ({ verifyAcpSignature: () => true }));
    vi.doMock("~/lib/commerce/acp/session-store.server", () => ({
      getAcpSession: async () => ({ sessionId: "acp_1", shopId: "shop_test", clientId: "c1", quoteId: "q1", orderId: null, status: "open" }),
      claimAcpSessionForCompletion: async () => true,
      releaseAcpSessionClaim: release,
      completeAcpSession: complete,
    }));
    vi.doMock("~/lib/commerce/quote-store.server", () => ({ getQuote: async () => ({ quoteId: "q1", totalCents: 2660, currency: "usd" }) }));
    vi.doMock("~/lib/payments/stripe.server", () => ({ isSupportedCurrency: (c: string) => SUPPORTED.has(c.toLowerCase()) }));
    vi.doMock("~/lib/commerce/guardrail.server", () => ({ assertWithinCommerceCap: async () => {} }));
    vi.doMock("~/lib/commerce/order.server", () => ({ placeAgenticOrder: async () => ({ orderId: "order1", confirmationToken: "t", totalCents: 2660, currency: "usd" }) }));
    // The gate passed on stale flags; the charge's routing decision then fails closed
    // (thrown strictly before any Stripe call — no money moved).
    vi.doMock("~/lib/commerce/acp/charge.server", async () => {
      const { PaymentsNotReadyError } = await import("~/lib/payments/errors");
      return { chargeSharedPaymentToken: async () => { throw new PaymentsNotReadyError("shop_test", "onboarding_incomplete"); } };
    });
    vi.doMock("~/lib/payments/connect.server", () => ({ paymentsReadiness: async () => ({ ready: true, route: "destination" }) }));
    const { action } = await import("../acp.checkout_sessions.$id.complete");
    const req = new Request("https://app/acp/checkout_sessions/acp_1/complete", { method: "POST", body: JSON.stringify({ payment: { shared_payment_token: "spt_1" }, buyer: { email: "b@x.com" } }) });
    const res = await action({ request: req, params: { id: "acp_1" }, context: {} } as never);
    expect(res.status).toBe(503);
    expect(release).toHaveBeenCalledWith("acp_1"); // retryable once onboarding completes
    expect(complete).not.toHaveBeenCalled();
  });
});
