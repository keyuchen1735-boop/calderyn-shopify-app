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
    expect(query).toContain("shippingAddress { city provinceCode countryCodeV2 }");
    expect(query).not.toMatch(/address1|address2|zip|phone|name|email|lineItems|totalPrice/i);
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

describe("fetchProductFactPages", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("paginates products while selecting only explicitly allowed metafields", async () => {
    graphql
      .mockResolvedValueOnce({ json: async () => ({ data: { products: {
        pageInfo: { hasNextPage: true, endCursor: "next" }, nodes: [{ id: "gid://shopify/Product/1", title: "One" }],
      } } }) })
      .mockResolvedValueOnce({ json: async () => ({ data: { products: {
        pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: "gid://shopify/Product/2", title: "Two" }],
      } } }) });
    const { fetchProductFactPages } = await import("../shopify-admin.server");
    const pages = [];
    for await (const page of fetchProductFactPages("one.myshopify.com")) pages.push(page);
    expect(pages.flat().map(({ id }) => id)).toEqual(["gid://shopify/Product/1", "gid://shopify/Product/2"]);
    expect(graphql.mock.calls.map(([, options]) => options.variables.cursor)).toEqual([null, "next"]);
    const query = graphql.mock.calls[0][0] as string;
    expect(query).toContain('metafield(namespace: "custom", key: "calderyn_width")');
    expect(query).toContain('metafield(namespace: "custom", key: "calderyn_ar_model_url")');
    expect(query).not.toMatch(/\bmetafields\s*\(/);
  });

  it.each([
    ["null", null, null],
    ["empty", "", null],
    ["non-advancing", "same", "same"],
  ])("fails closed on a %s next cursor before replacing facts", async (_case, firstCursor, secondCursor) => {
    graphql.mockResolvedValueOnce({ json: async () => ({ data: { products: {
      pageInfo: { hasNextPage: true, endCursor: firstCursor }, nodes: [{ id: "gid://shopify/Product/1", title: "One" }],
    } } }) });
    if (secondCursor !== null) {
      graphql.mockResolvedValueOnce({ json: async () => ({ data: { products: {
        pageInfo: { hasNextPage: true, endCursor: secondCursor }, nodes: [{ id: "gid://shopify/Product/2", title: "Two" }],
      } } }) });
    }
    const { fetchProductFactPages } = await import("../shopify-admin.server");
    const { syncShopifyProductFacts } = await import("../product-facts.server");
    const replace = vi.fn<(_: unknown) => Promise<void>>(async () => undefined);
    await expect(syncShopifyProductFacts(
      { shopId: "shop-1", shopDomain: "one.myshopify.com" },
      { fetch: fetchProductFactPages, replace },
    )).rejects.toThrow(/invalid next cursor/);
    expect(replace).not.toHaveBeenCalled();
  });
});
