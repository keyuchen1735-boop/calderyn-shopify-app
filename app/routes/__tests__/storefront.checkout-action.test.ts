import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";

// Fakes for the tenant resolver + order helpers. The cart-cookie helpers stay REAL (pure, no DB)
// so the action exercises the actual signed-cookie round-trip it relies on to read the cart id.
const resolveStorefrontShop = vi.fn();
const priceCart = vi.fn();
const createCheckout = vi.fn();
const paymentsReadiness = vi.fn();

// Real class so the route's `err instanceof OutOfStockError` branch (-> 409) is exercised. Defined
// via vi.hoisted so it exists when the (hoisted) vi.mock factory below references it. The payments
// and origin error classes are NOT faked — they live in dependency-free errors modules the route
// (and this test) import for real, so instanceof matches by construction.
const { OutOfStockError } = vi.hoisted(() => ({
  OutOfStockError: class OutOfStockError extends Error {
    readonly variantIds: string[];
    constructor(variantIds: string[]) {
      super(`out of stock: ${variantIds.join(", ")}`);
      this.name = "OutOfStockError";
      this.variantIds = variantIds;
    }
  },
}));

vi.mock("~/lib/storefront/shop.server", () => ({
  resolveStorefrontShop: (...a: unknown[]) => resolveStorefrontShop(...a),
  DEMO_SHOP_ID: "demo-shop",
}));
vi.mock("~/lib/order/cart.server", () => ({
  priceCart: (...a: unknown[]) => priceCart(...a),
}));
vi.mock("~/lib/order/checkout.server", () => ({
  createCheckout: (...a: unknown[]) => createCheckout(...a),
  OutOfStockError,
}));
vi.mock("~/lib/payments/connect.server", () => ({
  paymentsReadiness: (...a: unknown[]) => paymentsReadiness(...a),
}));

// eslint-disable-next-line import/first -- imports must follow vi.mock so the fakes register first
import { commitCartId } from "~/lib/storefront/cart-cookie.server";
// eslint-disable-next-line import/first -- real dependency-free error class the route catches by instanceof
import { ShipRestrictedError } from "~/lib/shipping/errors";
// eslint-disable-next-line import/first -- real dependency-free error class the route catches by instanceof
import { PaymentsNotReadyError } from "~/lib/payments/errors";
// eslint-disable-next-line import/first -- real dependency-free error class the route catches by instanceof
import { OriginNotConfiguredError } from "~/lib/commerce/errors";
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
  paymentsReadiness.mockResolvedValue({ ready: true, route: "destination" });
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
    expect(body.paymentsReady).toBe(true);
    expect(body.summary.subtotalCents).toBe(3998);
    expect(body.summary.lines).toHaveLength(1);
    // No secret material leaks through the loader payload.
    expect(JSON.stringify(body)).not.toContain("sk_");
  });

  it("flags paymentsReady=false when the merchant has no fully-enabled Stripe account", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    paymentsReadiness.mockResolvedValueOnce({ ready: false, reason: "no_account" });
    const req = new Request("https://shop.example/storefront/checkout", { headers: { Cookie: await cartCookie() } });
    const res = await loader(loaderArgs(req));
    expect((await (res as Response).json()).paymentsReady).toBe(false);
    spy.mockRestore();
  });

  it("fails CLOSED (paymentsReady=false, no 500) when the readiness lookup errors", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    paymentsReadiness.mockRejectedValueOnce(new Error("db blip"));
    const req = new Request("https://shop.example/storefront/checkout", { headers: { Cookie: await cartCookie() } });
    const res = await loader(loaderArgs(req));
    expect((await (res as Response).json()).paymentsReady).toBe(false);
    spy.mockRestore();
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

  it("rejects a non-ISO country BEFORE any Stripe call (400, no checkout)", async () => {
    // A free-text / autofilled full name that is not a 2-letter code and not a known alias.
    const res = await action(actionArgs(await postForm({ ...GOOD_FIELDS, country: "Freedonia" }, { cookie: await cartCookie() })));
    expect((res as Response).status).toBe(400);
    expect((await (res as Response).json()).error).toMatch(/valid country/);
    expect(createCheckout).not.toHaveBeenCalled();
  });

  it("normalizes a common full country name to its ISO alpha-2 code before checkout", async () => {
    const res = await action(actionArgs(await postForm({ ...GOOD_FIELDS, country: "United States" }, { cookie: await cartCookie() })));
    expect((res as Response).status).toBe(200);
    expect(createCheckout.mock.calls[0][2].address.country).toBe("US");
  });

  it("upper-cases a lower-case 2-letter code before checkout", async () => {
    const res = await action(actionArgs(await postForm({ ...GOOD_FIELDS, country: "gb" }, { cookie: await cartCookie() })));
    expect((res as Response).status).toBe(200);
    expect(createCheckout.mock.calls[0][2].address.country).toBe("GB");
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
    const [shopId, cartId, buyer, attribution] = createCheckout.mock.calls[0];
    expect(shopId).toBe("shop-1");
    expect(cartId).toBe("cart-1");
    // The live-analytics session is stamped onto the order's attribution so
    // the Live View funnel can anchor "purchased" on paid orders (the Stripe
    // webhook has no browser cookies).
    expect((attribution as { live_session_id?: string }).live_session_id).toMatch(
      /^[0-9a-f-]{36}$/,
    );
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

  it("maps an out-of-stock checkout to an actionable 409 (not a generic 502)", async () => {
    createCheckout.mockRejectedValueOnce(new OutOfStockError(["v1"]));
    const res = await action(actionArgs(await postForm(GOOD_FIELDS, { cookie: await cartCookie() })));
    expect((res as Response).status).toBe(409);
    expect((await (res as Response).json()).error).toMatch(/sold out/);
  });

  it("maps a payments-not-ready checkout to an honest 503 (buyer money never lands in the platform account)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    createCheckout.mockRejectedValueOnce(new PaymentsNotReadyError("shop-1", "no_account"));
    const res = await action(actionArgs(await postForm(GOOD_FIELDS, { cookie: await cartCookie() })));
    expect((res as Response).status).toBe(503);
    expect((await (res as Response).json()).error).toMatch(/isn't accepting payments yet/);
    spy.mockRestore();
  });

  it("maps a ship-restricted cart to an actionable 422 with the destination country", async () => {
    createCheckout.mockRejectedValueOnce(new ShipRestrictedError("CA", ["v1"]));
    const res = await action(actionArgs(await postForm(GOOD_FIELDS, { cookie: await cartCookie() })));
    expect((res as Response).status).toBe(422);
    expect((await (res as Response).json()).error).toMatch(/can't be shipped to CA/);
  });

  it("maps a missing ship-from origin to an honest 503 (retrying can't help the buyer)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    createCheckout.mockRejectedValueOnce(new OriginNotConfiguredError("shop-1"));
    const res = await action(actionArgs(await postForm(GOOD_FIELDS, { cookie: await cartCookie() })));
    expect((res as Response).status).toBe(503);
    expect((await (res as Response).json()).error).toMatch(/can't ship orders yet/);
    spy.mockRestore();
  });

  it("still maps an unexpected checkout failure to a 502", async () => {
    createCheckout.mockRejectedValueOnce(new Error("stripe network blip"));
    const res = await action(actionArgs(await postForm(GOOD_FIELDS, { cookie: await cartCookie() })));
    expect((res as Response).status).toBe(502);
  });
});

describe("payments not configured (no Stripe keys)", () => {
  it("loader returns a null publishableKey instead of a 500", async () => {
    delete process.env.STRIPE_PUBLISHABLE_KEY;
    const req = new Request("https://shop.example/storefront/checkout", { headers: { Cookie: await cartCookie() } });
    const res = await loader(loaderArgs(req));
    const body = await (res as Response).json();
    expect(body.publishableKey).toBeNull();
    expect(body.summary.subtotalCents).toBe(3998);
  });

  it("action refuses with 503 before originating a checkout", async () => {
    delete process.env.STRIPE_PUBLISHABLE_KEY;
    const res = await action(actionArgs(await postForm(GOOD_FIELDS, { cookie: await cartCookie() })));
    expect((res as Response).status).toBe(503);
    expect(createCheckout).not.toHaveBeenCalled();
  });
});

describe("demo shell is browse-only at checkout", () => {
  it("loader bounces the demo tenant to the cart without pricing", async () => {
    resolveStorefrontShop.mockResolvedValue("demo-shop");
    const req = new Request("https://shop.example/storefront/checkout", { headers: { Cookie: await cartCookie() } });
    const res = await loader(loaderArgs(req));
    expect((res as Response).status).toBe(302);
    expect((res as Response).headers.get("Location")).toBe("/storefront/cart");
    expect(priceCart).not.toHaveBeenCalled();
  });

  it("action bounces the demo tenant to the cart without originating", async () => {
    resolveStorefrontShop.mockResolvedValue("demo-shop");
    const res = await action(actionArgs(await postForm(GOOD_FIELDS, { cookie: await cartCookie() })));
    expect((res as Response).status).toBe(302);
    expect(createCheckout).not.toHaveBeenCalled();
  });
});
