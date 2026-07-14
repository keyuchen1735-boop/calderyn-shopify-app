import { beforeEach, describe, expect, it, vi } from "vitest";

const graphql = vi.fn();
const unauthenticatedAdmin = vi.fn(async () => ({ admin: { graphql } }));

vi.mock("../../../shopify.server", () => ({
  unauthenticated: { admin: unauthenticatedAdmin },
}));

describe("fetchOrderDestinationsByIds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches exact order IDs with only coarse destination geography", async () => {
    graphql.mockResolvedValue({
      json: async () => ({
        data: {
          nodes: [
              {
                id: "gid://shopify/Order/1",
                shippingAddress: { city: "Toronto", provinceCode: "ON", countryCodeV2: "CA" },
              },
              null,
            ],
        },
      }),
    });

    const { fetchOrderDestinationsByIds } = await import("../shopify-admin.server");
    const orders = await fetchOrderDestinationsByIds(
      "one.myshopify.com",
      ["gid://shopify/Order/1", "gid://shopify/Order/2"],
    );

    expect(orders).toEqual([
      { id: "gid://shopify/Order/1", city: "Toronto", region: "ON", country: "CA" },
    ]);
    const [query, options] = graphql.mock.calls[0];
    expect(options.variables).toEqual({
      ids: ["gid://shopify/Order/1", "gid://shopify/Order/2"],
    });
    expect(query).toContain("nodes(ids: $ids)");
    expect(query).toContain("... on Order");
    expect(query).toContain("shippingAddress { city province provinceCode country countryCodeV2 }");
    expect(query).not.toMatch(/address1|address2|zip|phone|name|email|lineItems|totalPrice/i);
  });

  it("falls back to province/country names when Shopify has no ISO codes", async () => {
    graphql.mockResolvedValue({
      json: async () => ({
        data: {
          nodes: [
            {
              id: "gid://shopify/Order/7",
              shippingAddress: {
                city: "Kyoto",
                province: "Kyoto Prefecture",
                provinceCode: null,
                country: "Japan",
                countryCodeV2: null,
              },
            },
          ],
        },
      }),
    });

    const { fetchOrderDestinationsByIds } = await import("../shopify-admin.server");
    const orders = await fetchOrderDestinationsByIds("one.myshopify.com", ["gid://shopify/Order/7"]);

    expect(orders).toEqual([
      { id: "gid://shopify/Order/7", city: "Kyoto", region: "Kyoto Prefecture", country: "Japan" },
    ]);
  });

  it("rejects ID batches outside the production bound", async () => {
    const { fetchOrderDestinationsByIds } = await import("../shopify-admin.server");
    await expect(
      fetchOrderDestinationsByIds(
        "one.myshopify.com",
        Array.from({ length: 51 }, (_, index) => `gid://shopify/Order/${index + 1}`),
      ),
    ).rejects.toThrow("batch");
    expect(graphql).not.toHaveBeenCalled();
  });

  it("rejects non-Order GIDs before making an Admin API request", async () => {
    const { fetchOrderDestinationsByIds } = await import("../shopify-admin.server");
    await expect(
      fetchOrderDestinationsByIds("one.myshopify.com", ["gid://shopify/Product/1"]),
    ).rejects.toThrow("Order GID");
    expect(graphql).not.toHaveBeenCalled();
  });
});
