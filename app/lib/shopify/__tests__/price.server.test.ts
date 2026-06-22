// app/lib/shopify/__tests__/price.server.test.ts
import { describe, it, expect, vi } from "vitest";
import { readVariantPrice, setVariantPrice } from "../price.server";

const VID = "gid://shopify/ProductVariant/123";
const PID = "gid://shopify/Product/999";

/** Minimal AdminGraphqlClient stub returning one canned GraphQL body. */
function adminReturning(body: unknown) {
  return {
    graphql: vi.fn(
      async (_query: string, _options?: { variables?: Record<string, unknown> }) =>
        ({ json: async () => body }) as unknown as Response,
    ),
  };
}

describe("readVariantPrice", () => {
  it("parses the variant's decimal price into cents and returns its product gid", async () => {
    const admin = adminReturning({
      data: { productVariant: { id: VID, price: "17.25", product: { id: PID } } },
    });
    const r = await readVariantPrice(admin, VID);
    expect(r).toEqual({ priceCents: 1725, productGid: PID });
  });
});

describe("setVariantPrice", () => {
  it("sends productVariantsBulkUpdate with the price as a decimal string and parses the echo", async () => {
    const admin = adminReturning({
      data: {
        productVariantsBulkUpdate: {
          productVariants: [{ id: VID, price: "17.25" }],
          userErrors: [],
        },
      },
    });
    const r = await setVariantPrice(admin, {
      productGid: PID,
      variantId: VID,
      newPriceCents: 1725,
    });
    expect(r).toEqual({ variantId: VID, priceCents: 1725 });
    // The Money scalar must be a decimal string, never cents.
    const [, opts] = admin.graphql.mock.calls[0];
    expect(opts).toEqual({
      variables: { productId: PID, variants: [{ id: VID, price: "17.25" }] },
    });
  });

  it("throws on a Shopify userError instead of reporting success", async () => {
    const admin = adminReturning({
      data: {
        productVariantsBulkUpdate: {
          productVariants: [],
          userErrors: [{ field: ["price"], message: "Price must be greater than 0" }],
        },
      },
    });
    await expect(
      setVariantPrice(admin, { productGid: PID, variantId: VID, newPriceCents: 1725 }),
    ).rejects.toThrow(/Price must be greater than 0/);
  });

  it("rejects a malformed variant gid before calling Shopify", async () => {
    const admin = adminReturning({});
    await expect(
      setVariantPrice(admin, { productGid: PID, variantId: "12345", newPriceCents: 1725 }),
    ).rejects.toThrow(/ProductVariant/);
    expect(admin.graphql).not.toHaveBeenCalled();
  });
});
