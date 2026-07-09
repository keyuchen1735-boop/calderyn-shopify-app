// app/routes/__tests__/storefront.checkout-experiment.test.ts
// D4 A/B conversion attribution: the checkout action stamps {experiment_id, variant_key}
// onto orders.attribution next to live_session_id, and the loader stamps the same pair
// onto its checkout_start funnel event. Bucketing (cookie-only ids, no coin flips for
// cookieless buyers, failure isolation) is the shared resolver's contract, unit-tested
// in store-experiment.server.test.ts.
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";

// Fakes for the tenant resolver + order helpers + the shared experiment resolver. The
// cart-cookie and visitor-cookie helpers stay REAL (pure, no DB) so the action exercises
// the actual signed-cookie round-trip, mirroring storefront.checkout-action.test.ts.
const resolveStorefrontShop = vi.fn();
const priceCart = vi.fn();
const createCheckout = vi.fn();
const resolveServedExperiment = vi.fn();
const trackStorefrontEvent = vi.fn();

vi.mock("~/lib/storefront/shop.server", () => ({
  resolveStorefrontShop: (...a: unknown[]) => resolveStorefrontShop(...a),
  DEMO_SHOP_ID: "demo-shop",
}));
vi.mock("~/lib/order/cart.server", () => ({
  priceCart: (...a: unknown[]) => priceCart(...a),
}));
vi.mock("~/lib/order/checkout.server", () => ({
  createCheckout: (...a: unknown[]) => createCheckout(...a),
}));
vi.mock("~/lib/experiments/store-experiment.server", () => ({
  resolveServedExperiment: (...a: unknown[]) => resolveServedExperiment(...a),
}));
vi.mock("~/lib/storefront/events.server", () => ({
  trackStorefrontEvent: (...a: unknown[]) => trackStorefrontEvent(...a),
}));

// eslint-disable-next-line import/first -- imports must follow vi.mock so the fakes register first
import { commitCartId } from "~/lib/storefront/cart-cookie.server";
// eslint-disable-next-line import/first
import { action, loader } from "../storefront.checkout";

const SECRET = "test-app-secret-0000000000000000000000000000";

const GOOD_FIELDS: Record<string, string> = {
  email: "buyer@example.com",
  name: "Ada Buyer",
  line1: "1 Market St",
  city: "San Francisco",
  region: "CA",
  postal: "94105",
  country: "US",
  tos: "on",
  privacy: "on",
};

const NOT_SERVED = { experiment: null, experimentId: null, variantKey: null };

async function postForm(fields: Record<string, string>, cookie: string): Promise<Request> {
  return new Request("https://shop.example/storefront/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
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
  resolveServedExperiment.mockResolvedValue(NOT_SERVED);
  trackStorefrontEvent.mockResolvedValue(new Headers());
  priceCart.mockResolvedValue({
    cartId: "cart-1",
    lines: [
      { id: "l1", variantId: "v1", quantity: 1, unitPriceCents: 1999, currency: "usd", titleSnapshot: "Tee" },
    ],
    subtotalCents: 1999,
    currency: "usd",
  });
  createCheckout.mockResolvedValue({
    orderId: "order-1",
    clientSecret: "pi_1_secret_abc",
    confirmationToken: "tok-abc",
    subtotalCents: 1999,
    shippingCents: 599,
    taxCents: 200,
    totalCents: 2798,
    currency: "usd",
  });
});

describe("checkout A/B attribution", () => {
  it("stamps {experiment_id, variant_key} onto attribution next to live_session_id when served", async () => {
    resolveServedExperiment.mockResolvedValue({
      experiment: { id: "exp-9", pageKey: "home" },
      experimentId: "exp-9",
      variantKey: "b",
    });

    const res = await action(actionArgs(await postForm(GOOD_FIELDS, await cartCookie())));
    expect(res.status).toBe(200);

    expect(createCheckout).toHaveBeenCalledTimes(1);
    const attribution = createCheckout.mock.calls[0][3] as Record<string, unknown>;
    expect(attribution.experiment_id).toBe("exp-9");
    expect(attribution.variant_key).toBe("b");
    expect(attribution.live_session_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(resolveServedExperiment).toHaveBeenCalledWith("shop-1", expect.any(Request), "checkout");
  });

  it("not served (no test / no cookie / lookup failure inside the resolver): stamps nothing beyond live_session_id", async () => {
    const res = await action(actionArgs(await postForm(GOOD_FIELDS, await cartCookie())));
    expect(res.status).toBe(200);

    const attribution = createCheckout.mock.calls[0][3] as Record<string, unknown>;
    expect(attribution).not.toHaveProperty("experiment_id");
    expect(attribution).not.toHaveProperty("variant_key");
    expect(attribution.live_session_id).toBeTruthy();
  });
});

describe("checkout loader funnel stamping", () => {
  const getRequest = async () =>
    new Request("https://shop.example/storefront/checkout", {
      headers: { Cookie: await cartCookie() },
    });

  it("stamps checkout_start with the served experiment", async () => {
    resolveServedExperiment.mockResolvedValue({
      experiment: { id: "exp-9", pageKey: "home" },
      experimentId: "exp-9",
      variantKey: "b",
    });

    const res = (await loader(loaderArgs(await getRequest()))) as Response;
    expect(res.status).toBe(200);

    expect(resolveServedExperiment).toHaveBeenCalledWith("shop-1", expect.any(Request), "checkout");
    const start = trackStorefrontEvent.mock.calls.find((c) => c[2] === "checkout_start");
    expect(start).toBeTruthy();
    expect(start?.[3]).toMatchObject({ experimentId: "exp-9", variantKey: "b" });
  });

  it("not served: checkout_start carries null experiment opts (no stamp columns written)", async () => {
    const res = (await loader(loaderArgs(await getRequest()))) as Response;
    expect(res.status).toBe(200);
    const start = trackStorefrontEvent.mock.calls.find((c) => c[2] === "checkout_start");
    expect(start?.[3]).toMatchObject({ experimentId: null, variantKey: null });
  });
});
