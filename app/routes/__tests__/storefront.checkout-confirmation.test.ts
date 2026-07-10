import { describe, it, expect, beforeEach, vi } from "vitest";
import type { LoaderFunctionArgs } from "@remix-run/node";

// Fake the tenant resolver + the order lookup. clearCartId stays REAL (pure cookie) so the test
// verifies the actual expiring Set-Cookie the confirmation page emits.
const resolveStorefrontShop = vi.fn();
const findOrderByConfirmationToken = vi.fn();
const getCartState = vi.fn();

vi.mock("~/lib/storefront/shop.server", () => ({
  resolveStorefrontShop: (...a: unknown[]) => resolveStorefrontShop(...a),
  DEMO_SHOP_ID: "demo-shop",
}));
vi.mock("~/lib/order/checkout.server", () => ({
  findOrderByConfirmationToken: (...a: unknown[]) => findOrderByConfirmationToken(...a),
  // real-ish ref formatter so the loader payload is exercised end to end
  formatOrderRef: (id: string) => `#${id.replace(/-/g, "").slice(0, 8).toUpperCase()}`,
}));
vi.mock("~/lib/order/cart.server", () => ({
  getCartState: (...a: unknown[]) => getCartState(...a),
}));

// eslint-disable-next-line import/first -- imports must follow vi.mock so the fakes register first
import { commitCartId } from "~/lib/storefront/cart-cookie.server";
// eslint-disable-next-line import/first
import { loader } from "../storefront.checkout_.confirmation.$token";

const SECRET = "test-app-secret-0000000000000000000000000000";

const args = (token: string | undefined, cookie?: string) =>
  ({
    request: new Request(`https://shop.example/storefront/checkout/confirmation/${token ?? ""}`, {
      headers: cookie ? { Cookie: cookie } : {},
    }),
    params: { token },
    context: {},
  }) as unknown as LoaderFunctionArgs;

const PAID_ORDER = {
  orderId: "11112222-3333-4444-5555-666677778888",
  state: "paid",
  subtotalCents: 3998,
  shippingCents: 0,
  taxCents: 0,
  totalCents: 3998,
  currency: "usd",
  createdAt: "2026-06-29T00:00:00Z",
  lines: [{ title: "Tee", quantity: 2, unitPriceCents: 1999 }],
};

async function cartCookie(id: string): Promise<string> {
  return (await commitCartId(id)).split(";")[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SHOPIFY_API_SECRET = SECRET;
  resolveStorefrontShop.mockResolvedValue("shop-1");
  getCartState.mockResolvedValue(null);
});

describe("confirmation loader — IDOR safety", () => {
  it("404s on an unknown token (no order, no PII) and looks up scoped to the shop", async () => {
    findOrderByConfirmationToken.mockResolvedValue(null);
    const err = await loader(args("unknown-token")).catch((e) => e);
    expect(err).toBeInstanceOf(Response);
    expect((err as Response).status).toBe(404);
    // The lookup is shop-scoped: the resolved shop id is passed as the first arg.
    expect(findOrderByConfirmationToken).toHaveBeenCalledWith("shop-1", "unknown-token");
  });

  it("404s on a foreign-shop token (the shop-scoped lookup returns null for another tenant's order)", async () => {
    // findOrderByConfirmationToken is scoped by (shop_id, token); a token belonging to another
    // shop resolves to null under this shop -> 404, exposing nothing.
    findOrderByConfirmationToken.mockResolvedValue(null);
    const err = await loader(args("a-foreign-shops-token")).catch((e) => e);
    expect((err as Response).status).toBe(404);
  });

  it("404s when the token is absent without hitting the DB", async () => {
    const err = await loader(args(undefined)).catch((e) => e);
    expect((err as Response).status).toBe(404);
    expect(findOrderByConfirmationToken).not.toHaveBeenCalled();
  });

  it("404s on the demo shell host BEFORE any DB read (fix I3 — the sentinel shop id can't back a uuid-keyed orders lookup)", async () => {
    resolveStorefrontShop.mockResolvedValue("demo-shop");
    const err = await loader(args("some-token")).catch((e) => e);
    expect(err).toBeInstanceOf(Response);
    expect((err as Response).status).toBe(404);
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
    const body = await (res as Response).json();
    expect(body.ref).toBe("#11112222");
    expect(body.status).toBe("confirmed");
    expect(body.totalCents).toBe(3998);
    expect(body.lines).toEqual([{ title: "Tee", quantity: 2 }]);

    // Cart cookie is cleared on successful confirmation (no cart cookie here -> safe to clear).
    const setCookie = (res as Response).headers.get("Set-Cookie") ?? "";
    expect(setCookie).toContain("cd_cart=");
    expect(setCookie).toContain("Max-Age=0");
  });

  it("does NOT wipe the buyer's ACTIVE cart when viewing a past paid order's confirmation", async () => {
    // Buyer has an in-progress cart (state 'cart') and opens an old paid receipt from account history.
    findOrderByConfirmationToken.mockResolvedValue(PAID_ORDER);
    getCartState.mockResolvedValue("cart"); // active basket, NOT the purchased (consumed) cart
    const res = await loader(args("good-token", await cartCookie("active-cart-B")));
    // The confirmation renders, but the active cart cookie is preserved (no clearing Set-Cookie).
    const setCookie = (res as Response).headers.get("Set-Cookie") ?? "";
    expect(setCookie).not.toContain("Max-Age=0");
    expect(getCartState).toHaveBeenCalledWith("shop-1", "active-cart-B");
  });

  it("clears the cookie when it points at the CONSUMED (checkout_pending) cart that was purchased", async () => {
    findOrderByConfirmationToken.mockResolvedValue(PAID_ORDER);
    getCartState.mockResolvedValue("checkout_pending"); // the just-purchased cart
    const res = await loader(args("good-token", await cartCookie("purchased-cart-A")));
    const setCookie = (res as Response).headers.get("Set-Cookie") ?? "";
    expect(setCookie).toContain("cd_cart=");
    expect(setCookie).toContain("Max-Age=0");
  });

  it("reflects an unpaid (webhook-lagging) order as processing without failing", async () => {
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
    expect((res as Response).status).toBe(200);
    expect((await (res as Response).json()).status).toBe("processing");
  });

  it("surfaces a cancelled/refunded order with its terminal status, never the reassuring copy", async () => {
    for (const [state, expected] of [
      ["cancelled", "cancelled"],
      ["refunded", "refunded"],
    ] as const) {
      findOrderByConfirmationToken.mockResolvedValue({
        orderId: "bbbb2222-0000-0000-0000-000000000000",
        state,
        subtotalCents: 1000,
        shippingCents: 0,
        taxCents: 0,
        totalCents: 1000,
        currency: "usd",
        createdAt: "2026-06-29T00:00:00Z",
        lines: [],
      });
      const res = await loader(args("terminal-token"));
      expect((res as Response).status).toBe(200);
      expect((await (res as Response).json()).status).toBe(expected);
    }
  });
});
