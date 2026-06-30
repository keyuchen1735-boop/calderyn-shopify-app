import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";

// Fakes for the tenant resolver + order helpers. The cart-cookie helpers stay REAL (pure, no DB)
// so the action exercises the actual signed-cookie round-trip it relies on to read the cart id.
const resolveStorefrontShop = vi.fn();
const priceCart = vi.fn();
const createCheckout = vi.fn();

vi.mock("~/lib/storefront/shop.server", () => ({
  resolveStorefrontShop: (...a: unknown[]) => resolveStorefrontShop(...a),
}));
vi.mock("~/lib/order/cart.server", () => ({
  priceCart: (...a: unknown[]) => priceCart(...a),
}));
vi.mock("~/lib/order/checkout.server", () => ({
  createCheckout: (...a: unknown[]) => createCheckout(...a),
}));

// eslint-disable-next-line import/first -- imports must follow vi.mock so the fakes register first
import { commitCartId } from "~/lib/storefront/cart-cookie.server";
// eslint-disable-next-line import/first
import { action, loader } from "../storefront.checkout";

const SECRET = "test-app-secret-0000000000000000000000000000";

const GOOD_FIELDS: Record<string, string> = {
  email: "Buyer@Example.com",
  name: "Ada Buyer",
  line1: "1 Market St",
  city: "San Francisco",
  region: "CA",
  postal: "94105",
  country: "US",
  tos: "on",
  privacy: "on",
};

async function postForm(
  fields: Record<string, string>,
  opts: { cookie?: string; headers?: Record<string, string> } = {},
): Promise<Request> {
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    ...(opts.headers ?? {}),
  };
  if (opts.cookie) headers.Cookie = opts.cookie;
  return new Request("https://shop.example/storefront/checkout", {
    method: "POST",
    headers,
    body: new URLSearchParams(fields),
  });
}

const actionArgs = (request: Request) =>
  ({ request, params: {}, context: {} }) as unknown as ActionFunctionArgs;
const loaderArgs = (request: Request) =>
  ({ request, params: {}, context: {} }) as unknown as LoaderFunctionArgs;

async function cartCookie(): Promise<string> {
  return (await commitCartId("cart-1")).split(";")[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SHOPIFY_API_SECRET = SECRET;
  process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_x";
  resolveStorefrontShop.mockResolvedValue("shop-1");
  priceCart.mockResolvedValue({
    cartId: "cart-1",
    lines: [
      { id: "l1", variantId: "v1", quantity: 2, unitPriceCents: 1999, currency: "usd", titleSnapshot: "Tee" },
    ],
    subtotalCents: 3998,
    currency: "usd",
  });
  createCheckout.mockResolvedValue({
    orderId: "order-1",
    clientSecret: "pi_1_secret_abc",
    confirmationToken: "tok-abc",
    subtotalCents: 3998,
    shippingCents: 599,
    taxCents: 360,
    totalCents: 4957,
    currency: "usd",
  });
});

describe("checkout loader", () => {
  it("redirects to the cart when there is no cart cookie", async () => {
    const res = await loader(loaderArgs(new Request("https://shop.example/storefront/checkout")));
    expect((res as Response).status).toBe(302);
    expect((res as Response).headers.get("Location")).toBe("/storefront/cart");
    expect(priceCart).not.toHaveBeenCalled();
  });

  it("redirects to the cart when the cart is empty", async () => {
    priceCart.mockResolvedValueOnce({ cartId: "cart-1", lines: [], subtotalCents: 0, currency: "usd" });
    const req = new Request("https://shop.example/storefront/checkout", { headers: { Cookie: await cartCookie() } });
    const res = await loader(loaderArgs(req));
    expect((res as Response).status).toBe(302);
    expect((res as Response).headers.get("Location")).toBe("/storefront/cart");
  });

  it("returns the order summary + publishable key (never the secret key)", async () => {
    const req = new Request("https://shop.example/storefront/checkout", { headers: { Cookie: await cartCookie() } });
    const res = await loader(loaderArgs(req));
    const body = await (res as Response).json();
    expect(body.publishableKey).toBe("pk_test_x");
    expect(body.summary.subtotalCents).toBe(3998);
    expect(body.summary.lines).toHaveLength(1);
    // No secret material leaks through the loader payload.
    expect(JSON.stringify(body)).not.toContain("sk_");
  });
});

describe("checkout action validation (fail visibly)", () => {
  it("rejects a missing/invalid email (400, no checkout)", async () => {
    const res = await action(actionArgs(await postForm({ ...GOOD_FIELDS, email: "not-an-email" }, { cookie: await cartCookie() })));
    expect((res as Response).status).toBe(400);
    expect((await (res as Response).json()).error).toMatch(/valid email/);
    expect(createCheckout).not.toHaveBeenCalled();
  });

  it("rejects a missing shipping field (400, no checkout)", async () => {
    const { postal: _omit, ...noPostal } = GOOD_FIELDS;
    const res = await action(actionArgs(await postForm(noPostal, { cookie: await cartCookie() })));
    expect((res as Response).status).toBe(400);
    expect((await (res as Response).json()).error).toMatch(/postal/);
    expect(createCheckout).not.toHaveBeenCalled();
  });

  it("rejects when ToS or privacy is not accepted (400, no checkout)", async () => {
    const { tos: _t, ...noTos } = GOOD_FIELDS;
    const res = await action(actionArgs(await postForm(noTos, { cookie: await cartCookie() })));
    expect((res as Response).status).toBe(400);
    expect((await (res as Response).json()).error).toMatch(/Terms of Service|Privacy/);
    expect(createCheckout).not.toHaveBeenCalled();
  });

  it("redirects to the cart when there is no cart cookie (nothing to check out)", async () => {
    const res = await action(actionArgs(await postForm(GOOD_FIELDS)));
    expect((res as Response).status).toBe(302);
    expect((res as Response).headers.get("Location")).toBe("/storefront/cart");
    expect(createCheckout).not.toHaveBeenCalled();
  });
});

describe("checkout action happy path", () => {
  it("originates the checkout with a normalized buyer + address + consent, and returns the client secret + token", async () => {
    const req = await postForm(GOOD_FIELDS, {
      cookie: await cartCookie(),
      headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1", "user-agent": "TestAgent/1.0" },
    });
    const res = await action(actionArgs(req));

    expect((res as Response).status).toBe(200);
    expect(createCheckout).toHaveBeenCalledTimes(1);
    const [shopId, cartId, buyer] = createCheckout.mock.calls[0];
    expect(shopId).toBe("shop-1");
    expect(cartId).toBe("cart-1");
    expect(buyer.email).toBe("buyer@example.com"); // normalized to lowercase
    expect(buyer.address).toMatchObject({ kind: "shipping", line1: "1 Market St", country: "US", isDefault: true });
    expect(buyer.consent).toMatchObject({
      marketingOptIn: false,
      sourceIp: "203.0.113.7", // first x-forwarded-for hop
      ua: "TestAgent/1.0",
    });
    expect(buyer.consent.version).toBeTruthy();

    const body = await (res as Response).json();
    expect(body).toEqual({
      clientSecret: "pi_1_secret_abc",
      confirmationToken: "tok-abc",
      subtotalCents: 3998,
      shippingCents: 599,
      taxCents: 360,
      totalCents: 4957,
      currency: "usd",
    });
    // The cart is NOT cleared at the action — payment can still fail.
    expect((res as Response).headers.get("Set-Cookie")).toBeNull();
  });

  it("captures the marketing opt-in when the box is checked", async () => {
    const req = await postForm({ ...GOOD_FIELDS, marketing: "on" }, { cookie: await cartCookie() });
    await action(actionArgs(req));
    expect(createCheckout.mock.calls[0][2].consent.marketingOptIn).toBe(true);
  });
});
