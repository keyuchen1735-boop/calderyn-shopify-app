import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ActionFunctionArgs } from "@remix-run/node";

// Fakes for the cart helpers + tenant resolver. The cart-cookie helpers stay REAL
// (pure, no DB) so the test exercises the actual sign/parse round-trip the action
// relies on. catalog.server is stubbed only so the route module imports cleanly.
const buildCart = vi.fn();
const addCartLine = vi.fn();
const resolveStorefrontShop = vi.fn();

// Real class so the route's `err instanceof VariantUnavailableError` branch is exercised. Defined
// via vi.hoisted so it exists when the (hoisted) vi.mock factory below references it.
const { VariantUnavailableError } = vi.hoisted(() => ({
  VariantUnavailableError: class VariantUnavailableError extends Error {
    readonly variantId: string;
    constructor(variantId: string) {
      super(`variant ${variantId} is not available`);
      this.name = "VariantUnavailableError";
      this.variantId = variantId;
    }
  },
}));

vi.mock("~/lib/order/cart.server", () => ({
  buildCart: (...a: unknown[]) => buildCart(...a),
  addCartLine: (...a: unknown[]) => addCartLine(...a),
  priceCart: vi.fn(),
  VariantUnavailableError,
}));
vi.mock("~/lib/storefront/shop.server", () => ({
  resolveStorefrontShop: (...a: unknown[]) => resolveStorefrontShop(...a),
  DEMO_SHOP_ID: "demo-shop",
}));
vi.mock("~/lib/storefront/catalog.server", () => ({ getCatalog: () => ({}) }));

// eslint-disable-next-line import/first -- imports must follow vi.mock so the fakes register first
import { commitCartId } from "~/lib/storefront/cart-cookie.server";
// eslint-disable-next-line import/first
import { action } from "../storefront.products.$handle";

const SECRET = "test-app-secret-0000000000000000000000000000";

function postForm(fields: Record<string, string>, cookie?: string): Request {
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (cookie) headers.Cookie = cookie;
  return new Request("https://shop.example/storefront/products/tee", {
    method: "POST",
    headers,
    body: new URLSearchParams(fields),
  });
}

const args = (request: Request) =>
  ({ request, params: {}, context: {} }) as unknown as ActionFunctionArgs;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SHOPIFY_API_SECRET = SECRET;
  resolveStorefrontShop.mockResolvedValue("shop-1");
  buildCart.mockResolvedValue({ id: "cart-new" });
  addCartLine.mockResolvedValue({});
});

describe("PDP add-to-cart action", () => {
  it("mints a cart + sets the cookie when none exists, then adds the line", async () => {
    const res = await action(args(postForm({ variantId: "v-1" })));

    expect(buildCart).toHaveBeenCalledWith("shop-1");
    expect(addCartLine).toHaveBeenCalledWith("shop-1", "cart-new", "v-1", 1);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/storefront/cart");
    expect(res.headers.get("Set-Cookie") ?? "").toContain("cd_cart=");
  });

  it("reuses the cart from the cookie (no new cart, no new cookie) and adds the line", async () => {
    const setCookie = await commitCartId("cart-existing");
    const res = await action(args(postForm({ variantId: "v-9" }, setCookie.split(";")[0])));

    expect(buildCart).not.toHaveBeenCalled();
    expect(addCartLine).toHaveBeenCalledWith("shop-1", "cart-existing", "v-9", 1);
    // No new CART cookie on reuse. (The live-analytics visitor/session cookies
    // legitimately ride every storefront response — see events.server.)
    expect(res.headers.get("Set-Cookie") ?? "").not.toContain("cd_cart=");
    expect(res.headers.get("Location")).toBe("/storefront/cart");
  });

  it("rejects a missing variantId at the boundary (400, no writes)", async () => {
    const err = await action(args(postForm({}))).catch((e) => e);
    expect(err).toBeInstanceOf(Response);
    expect((err as Response).status).toBe(400);
    expect(buildCart).not.toHaveBeenCalled();
    expect(addCartLine).not.toHaveBeenCalled();
  });

  it("redirects back to the PDP with a sold-out notice when the variant is unavailable (no 500)", async () => {
    addCartLine.mockRejectedValueOnce(new VariantUnavailableError("v-soldout"));
    const res = await action(args(postForm({ variantId: "v-soldout" })));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/storefront/products/tee?unavailable=1");
  });

  it("still propagates an unexpected addCartLine failure (genuine fault, not a sold-out redirect)", async () => {
    addCartLine.mockRejectedValueOnce(new Error("db exploded"));
    const err = await action(args(postForm({ variantId: "v-1" }))).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/db exploded/);
  });

  it("demo shell is browse-only: bounces back to the PDP without touching the cart", async () => {
    // The demo sentinel is not a uuid, so a cart write for it can only 500 —
    // the action must refuse before any cart helper runs.
    resolveStorefrontShop.mockResolvedValue("demo-shop");
    const res = await action(args(postForm({ variantId: "v-1" })));

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/storefront/products/tee");
    expect(buildCart).not.toHaveBeenCalled();
    expect(addCartLine).not.toHaveBeenCalled();
  });
});
