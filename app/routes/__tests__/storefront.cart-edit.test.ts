import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";

// Fakes for the cart helpers + tenant resolver. The cart-cookie helpers stay REAL (pure, no DB) so
// the action/loader exercise the actual signed-cookie round-trip they rely on to read the cart id.
const resolveStorefrontShop = vi.fn();
const priceCart = vi.fn();
const removeCartLine = vi.fn();
const clearCart = vi.fn();
const resolveRuntime1Route = vi.fn();

vi.mock("~/lib/order/cart.server", () => ({
  priceCart: (...a: unknown[]) => priceCart(...a),
  removeCartLine: (...a: unknown[]) => removeCartLine(...a),
  clearCart: (...a: unknown[]) => clearCart(...a),
}));
vi.mock("~/lib/storefront/shop.server", () => ({
  resolveStorefrontShop: (...a: unknown[]) => resolveStorefrontShop(...a),
  DEMO_SHOP_ID: "demo-shop",
}));
// events.server touches storefront_event; stub it so the loader's page_view tracking is a no-op.
vi.mock("~/lib/storefront/events.server", () => ({
  trackStorefrontEvent: vi.fn(async () => new Headers()),
}));
vi.mock("~/lib/storefront-runtime/release-resolution.server", () => ({
  resolveRuntime1Route: (...a: unknown[]) => resolveRuntime1Route(...a),
}));

// eslint-disable-next-line import/first -- imports must follow vi.mock so the fakes register first
import { commitCartId } from "~/lib/storefront/cart-cookie.server";
// eslint-disable-next-line import/first
import { action, loader } from "../storefront.cart";

const SECRET = "test-app-secret-0000000000000000000000000000";

async function cartCookie(id = "cart-1"): Promise<string> {
  return (await commitCartId(id)).split(";")[0];
}

function postForm(fields: Record<string, string>, cookie?: string): Request {
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
  if (cookie) headers.Cookie = cookie;
  return new Request("https://shop.example/storefront/cart", {
    method: "POST",
    headers,
    body: new URLSearchParams(fields),
  });
}

const actionArgs = (request: Request) => ({ request, params: {}, context: {} }) as unknown as ActionFunctionArgs;
const loaderArgs = (request: Request) => ({ request, params: {}, context: {} }) as unknown as LoaderFunctionArgs;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SHOPIFY_API_SECRET = SECRET;
  resolveStorefrontShop.mockResolvedValue("shop-1");
  priceCart.mockResolvedValue({
    cartId: "cart-1",
    lines: [{ id: "l1", variantId: "v1", quantity: 1, unitPriceCents: 1999, currency: "usd", titleSnapshot: "Tee" }],
    subtotalCents: 1999,
    currency: "usd",
  });
  removeCartLine.mockResolvedValue(undefined);
  clearCart.mockResolvedValue(undefined);
  resolveRuntime1Route.mockResolvedValue(null);
});

describe("cart edit action", () => {
  it("removes a single line and redirects back to the cart", async () => {
    const res = await action(actionArgs(postForm({ intent: "remove", lineId: "l1" }, await cartCookie())));
    expect(removeCartLine).toHaveBeenCalledWith("shop-1", "cart-1", "l1");
    expect((res as Response).status).toBe(302);
    expect((res as Response).headers.get("Location")).toBe("/storefront/cart");
  });

  it("empties the whole cart on intent=clear", async () => {
    const res = await action(actionArgs(postForm({ intent: "clear" }, await cartCookie())));
    expect(clearCart).toHaveBeenCalledWith("shop-1", "cart-1");
    expect((res as Response).status).toBe(302);
  });

  it("rejects a remove without a lineId (400, no delete)", async () => {
    const err = await action(actionArgs(postForm({ intent: "remove" }, await cartCookie()))).catch((e) => e);
    expect(err).toBeInstanceOf(Response);
    expect((err as Response).status).toBe(400);
    expect(removeCartLine).not.toHaveBeenCalled();
  });

  it("rejects an unknown intent (400)", async () => {
    const err = await action(actionArgs(postForm({ intent: "explode" }, await cartCookie()))).catch((e) => e);
    expect((err as Response).status).toBe(400);
  });

  it("redirects to the cart when there is no cart cookie (nothing to edit)", async () => {
    const res = await action(actionArgs(postForm({ intent: "clear" })));
    expect((res as Response).status).toBe(302);
    expect(clearCart).not.toHaveBeenCalled();
  });

  it("demo shell is browse-only: bounces without touching the cart", async () => {
    resolveStorefrontShop.mockResolvedValue("demo-shop");
    const res = await action(actionArgs(postForm({ intent: "clear" }, await cartCookie())));
    expect((res as Response).status).toBe(302);
    expect(clearCart).not.toHaveBeenCalled();
  });
});

describe("cart runtime cutover", () => {
  it("fails explicitly before loading the platform fallback when runtime-1 is absent", async () => {
    const run = loader(loaderArgs(new Request("https://shop.example/storefront/cart")));
    await expect(run).rejects.toMatchObject({ status: 503 });
    expect(priceCart).not.toHaveBeenCalled();
  });
});
