// app/lib/simulator/__tests__/fetch-pages.test.ts
import { describe, it, expect, vi } from "vitest";
import { fetchSnapshot, pickShippingRate } from "../fetch-pages.server";

const PRODUCTS_JSON = JSON.stringify({
  products: [
    {
      title: "Wool Beanie",
      handle: "wool-beanie",
      body_html: "<p>Warm &amp; cozy</p>",
      variants: [{ price: "29.00" }],
    },
  ],
});

function fakeFetch(map: Record<string, { ok: boolean; body: string }>) {
  return vi.fn(async (url: string) => {
    const hit = map[url];
    if (!hit) return { ok: false, status: 404, text: async () => "" } as unknown as Response;
    return { ok: hit.ok, status: hit.ok ? 200 : 500, text: async () => hit.body } as unknown as Response;
  });
}

const shippingData = {
  deliveryProfiles: {
    nodes: [
      {
        profileLocationGroups: [
          {
            locationGroupZones: {
              nodes: [
                {
                  methodDefinitions: {
                    nodes: [
                      { active: true, rateProvider: { __typename: "DeliveryRateDefinition", price: { amount: "9.95", currencyCode: "USD" } } },
                    ],
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  },
};

describe("pickShippingRate", () => {
  it("returns the lowest active flat rate", () => {
    expect(pickShippingRate(shippingData)).toEqual({ amount: 9.95, currency: "USD", estimated: false });
  });

  it("falls back to an estimate when no flat rate is found", () => {
    expect(pickShippingRate({ deliveryProfiles: { nodes: [] } })).toEqual({
      amount: 7.95,
      currency: "USD",
      estimated: true,
    });
  });
});

describe("fetchSnapshot", () => {
  it("builds a snapshot from home + products.json + shipping", async () => {
    const fetchImpl = fakeFetch({
      "https://acme.myshopify.com/": { ok: true, body: "<h1>Best socks</h1>" },
      "https://acme.myshopify.com/products.json?limit=5": { ok: true, body: PRODUCTS_JSON },
    });
    const admin = { graphql: vi.fn(async () => ({ json: async () => ({ data: shippingData }) })) };

    const snap = await fetchSnapshot("acme.myshopify.com", { fetchImpl: fetchImpl as never, admin: admin as never });

    expect(snap.homeText).toBe("Best socks");
    expect(snap.product).toEqual({
      title: "Wool Beanie",
      descriptionText: "Warm & cozy",
      priceText: "29.00",
      url: "https://acme.myshopify.com/products/wool-beanie",
    });
    expect(snap.shipping).toEqual({ amount: 9.95, currency: "USD", estimated: false });
  });

  it("tolerates products.json being disabled (product = null)", async () => {
    const fetchImpl = fakeFetch({
      "https://acme.myshopify.com/": { ok: true, body: "<h1>Hi</h1>" },
    });
    const admin = { graphql: vi.fn(async () => ({ json: async () => ({ data: shippingData }) })) };

    const snap = await fetchSnapshot("acme.myshopify.com", { fetchImpl: fetchImpl as never, admin: admin as never });
    expect(snap.product).toBeNull();
    expect(snap.homeText).toBe("Hi");
  });
});
