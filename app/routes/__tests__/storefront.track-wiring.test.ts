// app/routes/__tests__/storefront.track-wiring.test.ts
// Live-analytics wiring: storefront loaders/actions emit exactly one event and
// forward the visitor/session Set-Cookie headers on their responses.
import { describe, it, expect, vi, beforeEach } from "vitest";

const track = vi.fn(async (..._a: unknown[]) => {
  const h = new Headers();
  h.append("Set-Cookie", "cd_sid=test.n; Path=/");
  return h;
});
const resolveStorefrontShop = vi.fn(async (..._a: unknown[]) => "11111111-2222-3333-4444-555555555555");

vi.mock("~/lib/storefront/events.server", () => ({
  trackStorefrontEvent: (...a: unknown[]) => track(...a),
}));
vi.mock("~/lib/storefront/shop.server", () => ({
  resolveStorefrontShop: (...a: unknown[]) => resolveStorefrontShop(...a),
  DEMO_SHOP_ID: "demo-shop",
}));
vi.mock("~/lib/storefront/catalog.server", () => ({
  getCatalog: () => ({
    getProduct: vi.fn(async () => ({
      id: "p1",
      handle: "mug",
      title: "Mug",
      description: "",
      variants: [],
    })),
  }),
}));
vi.mock("~/lib/storebuilder/page-document.server", () => ({
  loadPublishedDoc: vi.fn(async () => null),
}));
vi.mock("~/lib/storebuilder/resolve-data.server", () => ({
  resolveRenderData: vi.fn(async () => null),
}));
vi.mock("~/lib/order/cart.server", () => ({
  buildCart: vi.fn(async () => ({ id: "cart-1" })),
  addCartLine: vi.fn(async () => ({ id: "line-1", productId: "p1" })),
  priceCart: vi.fn(async () => null),
}));

// eslint-disable-next-line import/first -- imports must follow vi.mock so the fakes register first
import { loader as pdpLoader, action as pdpAction } from "../storefront.products.$handle";

beforeEach(() => track.mockClear());

describe("storefront live-analytics wiring", () => {
  it("PDP loader emits page_view with the variant id and forwards Set-Cookie", async () => {
    const res = (await pdpLoader({
      request: new Request("https://x.example/storefront/products/mug"),
      params: { handle: "mug" },
      context: {},
    })) as Response;
    expect(track).toHaveBeenCalledTimes(1);
    expect(track.mock.calls[0][2]).toBe("page_view");
    expect(res.headers.getSetCookie().some((c) => c.startsWith("cd_sid="))).toBe(true);
  });

  it("PDP action emits cart_add and still redirects to the cart", async () => {
    const res = (await pdpAction({
      request: new Request("https://x.example/storefront/products/mug", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ variantId: "v1" }),
      }),
      params: { handle: "mug" },
      context: {},
    })) as Response;
    expect(track).toHaveBeenCalledTimes(1);
    expect(track.mock.calls[0][2]).toBe("cart_add");
    // cart_add records the owning PRODUCT id (same id kind as page_view), not the variant id.
    expect((track.mock.calls[0][3] as { productId?: string }).productId).toBe("p1");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/storefront/cart");
    expect(res.headers.getSetCookie().some((c) => c.startsWith("cd_sid="))).toBe(true);
  });
});
