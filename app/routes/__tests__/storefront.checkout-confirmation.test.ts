import { describe, it, expect, beforeEach, vi } from "vitest";
import { toResponse } from "../../lib/__tests__/_route-test-helpers";
import type { LoaderFunctionArgs } from "react-router";

// Fake the tenant resolver + the order lookup. clearCartId stays REAL (pure cookie) so the test
// verifies the actual expiring Set-Cookie the confirmation page emits.
const resolveStorefrontShop = vi.fn();
const findOrderByConfirmationToken = vi.fn();

vi.mock("~/lib/storefront/shop.server", () => ({
  resolveStorefrontShop: (...a: unknown[]) => resolveStorefrontShop(...a),
}));
vi.mock("~/lib/order/checkout.server", () => ({
  findOrderByConfirmationToken: (...a: unknown[]) => findOrderByConfirmationToken(...a),
  // real-ish ref formatter so the loader payload is exercised end to end
  formatOrderRef: (id: string) => `#${id.replace(/-/g, "").slice(0, 8).toUpperCase()}`,
}));

// eslint-disable-next-line import/first -- imports must follow vi.mock so the fakes register first
import { loader } from "../storefront.checkout.confirmation.$token";

const SECRET = "test-app-secret-0000000000000000000000000000";

const args = (token: string | undefined) =>
  ({
    request: new Request(`https://shop.example/storefront/checkout/confirmation/${token ?? ""}`),
    params: { token },
    context: {},
  }) as unknown as LoaderFunctionArgs;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SHOPIFY_API_SECRET = SECRET;
  resolveStorefrontShop.mockResolvedValue("shop-1");
});

describe("confirmation loader — IDOR safety", () => {
  it("404s on an unknown token (no order, no PII) and looks up scoped to the shop", async () => {
    findOrderByConfirmationToken.mockResolvedValue(null);
    const err = await loader(args("unknown-token")).catch((e) => e);
    expect(err).toBeInstanceOf(Response);
    expect(toResponse(err).status).toBe(404);
    // The lookup is shop-scoped: the resolved shop id is passed as the first arg.
    expect(findOrderByConfirmationToken).toHaveBeenCalledWith("shop-1", "unknown-token");
  });

  it("404s on a foreign-shop token (the shop-scoped lookup returns null for another tenant's order)", async () => {
    // findOrderByConfirmationToken is scoped by (shop_id, token); a token belonging to another
    // shop resolves to null under this shop -> 404, exposing nothing.
    findOrderByConfirmationToken.mockResolvedValue(null);
    const err = await loader(args("a-foreign-shops-token")).catch((e) => e);
    expect(toResponse(err).status).toBe(404);
  });

  it("404s when the token is absent without hitting the DB", async () => {
    const err = await loader(args(undefined)).catch((e) => e);
    expect(toResponse(err).status).toBe(404);
    expect(findOrderByConfirmationToken).not.toHaveBeenCalled();
  });

  it("renders a minimal summary and clears the cart cookie for a valid token", async () => {
    findOrderByConfirmationToken.mockResolvedValue({
      orderId: "11112222-3333-4444-5555-666677778888",
      state: "paid",
      subtotalCents: 3998,
      shippingCents: 0,
      taxCents: 0,
      totalCents: 3998,
      currency: "usd",
      createdAt: "2026-06-29T00:00:00Z",
      lines: [{ title: "Tee", quantity: 2, unitPriceCents: 1999 }],
    });
    const res = await loader(args("good-token"));
    const body = await toResponse(res).json();
    expect(body.ref).toBe("#11112222");
    expect(body.paid).toBe(true);
    expect(body.totalCents).toBe(3998);
    expect(body.lines).toEqual([{ title: "Tee", quantity: 2 }]);

    // Cart cookie is cleared on successful confirmation.
    const setCookie = toResponse(res).headers.get("Set-Cookie") ?? "";
    expect(setCookie).toContain("cd_cart=");
    expect(setCookie).toContain("Max-Age=0");
  });

  it("reflects an unpaid (webhook-lagging) order as not-yet-paid without failing", async () => {
    findOrderByConfirmationToken.mockResolvedValue({
      orderId: "aaaa1111-0000-0000-0000-000000000000",
      state: "checkout_pending",
      subtotalCents: 1000,
      shippingCents: 0,
      taxCents: 0,
      totalCents: 1000,
      currency: "usd",
      createdAt: "2026-06-29T00:00:00Z",
      lines: [],
    });
    const res = await loader(args("pending-token"));
    expect(toResponse(res).status).toBe(200);
    expect((await toResponse(res).json()).paid).toBe(false);
  });
});
