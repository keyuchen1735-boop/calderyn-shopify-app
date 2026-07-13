import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";

const calls = vi.hoisted(() => [] as string[]);
const resolveStorefrontShop = vi.hoisted(() => vi.fn(async () => { calls.push("resolve"); return "shop-a"; }));
const rateLimit = vi.hoisted(() => vi.fn(async () => true));
const cart = vi.hoisted(() => ({
  buildCart: vi.fn(async () => ({ id: "22222222-2222-4222-8222-222222222222" })),
  addCartLine: vi.fn(async () => { calls.push("add"); return {}; }),
  priceCart: vi.fn(async (_shopId: string, cartId: string) => { calls.push("price"); return { cartId, lines: [], subtotalCents: 0, currency: "usd" }; }),
  setCartLineQuantity: vi.fn(async () => ({ id: "line-1", quantity: 3 })),
  removeCartLine: vi.fn(async () => undefined),
  clearCart: vi.fn(async () => undefined),
  getCartState: vi.fn(async (): Promise<string | null> => { calls.push("state"); return "cart"; }),
}));

const { VariantUnavailableError, CartLineNotFoundError } = vi.hoisted(() => ({
  VariantUnavailableError: class VariantUnavailableError extends Error {
    constructor(readonly variantId: string, readonly reason: "not_found" | "unavailable") { super(reason); }
  },
  CartLineNotFoundError: class CartLineNotFoundError extends Error {},
}));

vi.mock("~/lib/storefront/shop.server", () => ({
  resolveStorefrontShop,
  DEMO_SHOP_ID: "demo-shop",
}));
vi.mock("~/lib/rate-limit.server", () => ({
  rateLimit,
  clientIpKey: (_request: Request, scope: string) => `${scope}:ip`,
}));
vi.mock("~/lib/order/cart.server", () => ({
  ...cart,
  VariantUnavailableError,
  CartLineNotFoundError,
}));

// eslint-disable-next-line import/first -- route imports follow hoisted mocks
import { commitCartId } from "~/lib/storefront/cart-cookie.server";
// eslint-disable-next-line import/first
import { loader as cartLoader } from "../storefront.api.cart";
// eslint-disable-next-line import/first
import { action as addAction } from "../storefront.api.cart.add";
// eslint-disable-next-line import/first
import { action as quantityAction } from "../storefront.api.cart.quantity";
// eslint-disable-next-line import/first
import { action as removeAction } from "../storefront.api.cart.remove";
// eslint-disable-next-line import/first
import { action as clearAction } from "../storefront.api.cart.clear";

const SECRET = "test-app-secret-0000000000000000000000000000";
const CART_ID = "11111111-1111-4111-8111-111111111111";
const NEW_CART_ID = "22222222-2222-4222-8222-222222222222";
const loaderArgs = (request: Request) => ({ request, params: {}, context: {} }) as LoaderFunctionArgs;
const actionArgs = (request: Request) => ({ request, params: {}, context: {} }) as ActionFunctionArgs;

async function cookie(cartId = CART_ID, shopId = "shop-a") {
  return (await commitCartId(cartId, shopId)).split(";")[0];
}

async function jsonRequest(path: string, body: unknown, options: { cookie?: string; origin?: string; contentType?: string } = {}) {
  return new Request(`https://shop.example${path}`, {
    method: "POST",
    headers: {
      Origin: options.origin ?? "https://shop.example",
      "Content-Type": options.contentType ?? "application/json",
      ...(options.cookie ? { Cookie: options.cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  process.env.SHOPIFY_API_SECRET = SECRET;
  resolveStorefrontShop.mockImplementation(async () => { calls.push("resolve"); return "shop-a"; });
  rateLimit.mockResolvedValue(true);
  cart.buildCart.mockResolvedValue({ id: NEW_CART_ID });
  cart.addCartLine.mockImplementation(async () => { calls.push("add"); return {}; });
  cart.priceCart.mockImplementation(async (_shopId: string, cartId: string) => { calls.push("price"); return { cartId, lines: [], subtotalCents: 0, currency: "usd" }; });
  cart.setCartLineQuantity.mockResolvedValue({ id: "line-1", quantity: 3 });
  cart.getCartState.mockImplementation(async () => { calls.push("state"); return "cart"; });
});

describe("storefront cart JSON bridge", () => {
  it("resolves the tenant before reading cart data and always returns private no-store JSON", async () => {
    const response = await cartLoader(loaderArgs(new Request("https://shop.example/storefront/api/cart", {
      headers: { Cookie: await cookie() },
    })));
    expect(calls).toEqual(["resolve", "state", "price"]);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(response.headers.get("Vary")).toContain("Cookie");
    expect(await response.json()).toEqual({ ok: true, data: { cart: expect.objectContaining({ cartId: CART_ID }) } });
  });

  it("rejects a signed cart belonging to another resolved shop before cart reads", async () => {
    const response = await cartLoader(loaderArgs(new Request("https://shop.example/storefront/api/cart", {
      headers: { Cookie: await cookie("33333333-3333-4333-8333-333333333333", "shop-b") },
    })));
    expect(response.status).toBe(403);
    expect(cart.priceCart).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({ ok: false, error: { code: "cart_shop_mismatch" } });
  });

  it("clears a stale or consumed cart identity without pricing it", async () => {
    cart.getCartState.mockImplementationOnce(async () => { calls.push("state"); return null; });
    const response = await cartLoader(loaderArgs(new Request("https://shop.example/storefront/api/cart", {
      headers: { Cookie: await cookie() },
    })));
    expect(calls).toEqual(["resolve", "state"]);
    expect(cart.priceCart).not.toHaveBeenCalled();
    expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect(await response.json()).toEqual({ ok: true, data: { cart: null } });
  });

  it("adds with server-owned snapshots and mints a shop-bound signed cart", async () => {
    const response = await addAction(actionArgs(await jsonRequest("/storefront/api/cart/add", { variantId: "v-1", quantity: 2 })));
    expect(cart.buildCart).toHaveBeenCalledWith("shop-a");
    expect(cart.addCartLine).toHaveBeenCalledWith("shop-a", NEW_CART_ID, "v-1", 2);
    expect(response.headers.get("Set-Cookie")).toContain("cd_cart=");
    expect(await response.json()).toEqual({ ok: true, data: { cart: expect.objectContaining({ cartId: NEW_CART_ID }) } });
  });

  it("requires exact same-origin JSON mutations with strict bodies", async () => {
    const foreign = await addAction(actionArgs(await jsonRequest("/storefront/api/cart/add", { variantId: "v-1", quantity: 1 }, { origin: "https://evil.example" })));
    expect(foreign.status).toBe(403);

    const wrongType = await addAction(actionArgs(await jsonRequest("/storefront/api/cart/add", { variantId: "v-1", quantity: 1 }, { contentType: "text/plain" })));
    expect(wrongType.status).toBe(415);

    const unknown = await addAction(actionArgs(await jsonRequest("/storefront/api/cart/add", { variantId: "v-1", quantity: 1, price: 1 })));
    expect(unknown.status).toBe(422);
    expect(cart.addCartLine).not.toHaveBeenCalled();
  });

  it("rate-limits mutations before parsing or cart/catalog work", async () => {
    rateLimit.mockResolvedValueOnce(false);
    const response = await addAction(actionArgs(await jsonRequest("/storefront/api/cart/add", { variantId: "v-1", quantity: 1 })));
    expect(response.status).toBe(429);
    expect(cart.buildCart).not.toHaveBeenCalled();
    expect(cart.addCartLine).not.toHaveBeenCalled();
  });

  it("maps live availability failures to structured public errors", async () => {
    cart.addCartLine.mockRejectedValueOnce(new VariantUnavailableError("v-sold", "unavailable"));
    const response = await addAction(actionArgs(await jsonRequest("/storefront/api/cart/add", { variantId: "v-sold", quantity: 1 }, { cookie: await cookie() })));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ ok: false, error: { code: "variant_unavailable" } });
  });

  it("sets quantity authoritatively and validates the 1-999 bound", async () => {
    const ok = await quantityAction(actionArgs(await jsonRequest("/storefront/api/cart/quantity", { lineId: "line-1", quantity: 3 }, { cookie: await cookie() })));
    expect(cart.setCartLineQuantity).toHaveBeenCalledWith("shop-a", CART_ID, "line-1", 3);
    expect(ok.status).toBe(200);

    const invalid = await quantityAction(actionArgs(await jsonRequest("/storefront/api/cart/quantity", { lineId: "line-1", quantity: 1000 }, { cookie: await cookie() })));
    expect(invalid.status).toBe(422);
  });

  it("supports scoped remove and clear without accepting cart IDs from the body", async () => {
    await removeAction(actionArgs(await jsonRequest("/storefront/api/cart/remove", { lineId: "line-1" }, { cookie: await cookie() })));
    expect(cart.removeCartLine).toHaveBeenCalledWith("shop-a", CART_ID, "line-1");

    await clearAction(actionArgs(await jsonRequest("/storefront/api/cart/clear", {}, { cookie: await cookie() })));
    expect(cart.clearCart).toHaveBeenCalledWith("shop-a", CART_ID);
  });

  it("recovers from a stale cookie by minting a new active cart on add", async () => {
    cart.getCartState.mockResolvedValueOnce("checkout_pending");
    const response = await addAction(actionArgs(await jsonRequest(
      "/storefront/api/cart/add",
      { variantId: "v-1", quantity: 1 },
      { cookie: await cookie() },
    )));
    expect(cart.buildCart).toHaveBeenCalledWith("shop-a");
    expect(cart.addCartLine).toHaveBeenCalledWith("shop-a", NEW_CART_ID, "v-1", 1);
    expect(response.headers.get("Set-Cookie")).toContain("cd_cart=");
  });
});
