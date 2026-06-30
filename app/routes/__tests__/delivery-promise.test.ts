import { describe, it, expect, vi, beforeEach } from "vitest";

const { resolveStorefrontShop, estimateShipping } = vi.hoisted(() => ({
  resolveStorefrontShop: vi.fn(),
  estimateShipping: vi.fn(),
}));
vi.mock("~/lib/storefront/shop.server", () => ({ resolveStorefrontShop }));
vi.mock("~/lib/commerce/estimate.server", () => ({ estimateShipping }));

const ESTIMATE = {
  cheapest: { serviceName: "Ground", carrier: "USPS", amountCents: 500, deliveryEarliest: "2026-07-04", deliveryLatest: "2026-07-07" },
  fastest: { serviceName: "Express", carrier: "USPS", amountCents: 1500, deliveryEarliest: "2026-07-02", deliveryLatest: "2026-07-02" },
  currency: "usd",
  isEstimate: true,
};

import { loader } from "../storefront.api.delivery-promise";

describe("delivery-promise loader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveStorefrontShop.mockResolvedValue("shop_test");
  });

  it("returns an estimate for a variant + zip", async () => {
    estimateShipping.mockResolvedValue(ESTIMATE);
    const req = new Request("https://shop/storefront/api/delivery-promise?variantId=V1&qty=1&zip=10001&country=US");
    const res = await loader({ request: req, params: {}, context: {} } as never);
    const data = (await res.json()) as { isEstimate: boolean; cheapest: { amountCents: number } };
    expect(res.status).toBe(200);
    expect(data.isEstimate).toBe(true);
    expect(data.cheapest.amountCents).toBe(500);
  });

  it("400s when zip is missing", async () => {
    const req = new Request("https://shop/storefront/api/delivery-promise?variantId=V1&qty=1");
    const res = await loader({ request: req, params: {}, context: {} } as never);
    expect(res.status).toBe(400);
  });

  it("400s when variantId is missing", async () => {
    const req = new Request("https://shop/storefront/api/delivery-promise?zip=10001");
    const res = await loader({ request: req, params: {}, context: {} } as never);
    expect(res.status).toBe(400);
  });

  it("422s when estimateShipping throws a configured error code", async () => {
    estimateShipping.mockRejectedValue(
      Object.assign(new Error("no carrier"), { code: "RATE_SOURCE_NOT_CONFIGURED" }),
    );
    const req = new Request("https://shop/storefront/api/delivery-promise?variantId=V1&zip=10001");
    const res = await loader({ request: req, params: {}, context: {} } as never);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("RATE_SOURCE_NOT_CONFIGURED");
  });
});
