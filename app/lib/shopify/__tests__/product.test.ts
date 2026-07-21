// app/lib/shopify/__tests__/product.test.ts
import { describe, it, expect, vi } from "vitest";
import { discontinueProduct, restoreProduct } from "../product.server";
import type { AdminGraphqlClient } from "../inventory.server";

function adminReturning(body: unknown): AdminGraphqlClient {
  return {
    graphql: vi.fn(async () => ({ json: async () => body }) as unknown as Response),
  };
}

const PRODUCT_GID = "gid://shopify/Product/123";

describe("discontinueProduct", () => {
  it("archives the product and returns its id", async () => {
    const admin = adminReturning({
      data: { productUpdate: { product: { id: PRODUCT_GID, status: "ARCHIVED" }, userErrors: [] } },
    });
    const res = await discontinueProduct(admin, PRODUCT_GID);
    expect(res.productId).toBe(PRODUCT_GID);
    expect(res.previousStatus).toBeNull(); // not read on the write; documented below
    const call = (admin.graphql as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(call[0])).toContain("productUpdate");
    expect(call[1]).toMatchObject({ variables: { product: { id: PRODUCT_GID, status: "ARCHIVED" } } });
  });

  it("throws on userErrors (rule 12 — no silent success)", async () => {
    const admin = adminReturning({
      data: { productUpdate: { product: null, userErrors: [{ field: ["id"], message: "not found" }] } },
    });
    await expect(discontinueProduct(admin, PRODUCT_GID)).rejects.toThrow(/not found/);
  });

  it("throws on top-level GraphQL errors", async () => {
    const admin = adminReturning({ errors: [{ message: "throttled" }] });
    await expect(discontinueProduct(admin, PRODUCT_GID)).rejects.toThrow(/throttled/);
  });
});

describe("restoreProduct", () => {
  it("re-activates the product to the recorded prior status", async () => {
    const admin = adminReturning({
      data: { productUpdate: { product: { id: PRODUCT_GID, status: "ACTIVE" }, userErrors: [] } },
    });
    const res = await restoreProduct(admin, PRODUCT_GID, "ACTIVE");
    expect(res.productId).toBe(PRODUCT_GID);
    const call = (admin.graphql as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1]).toMatchObject({ variables: { product: { id: PRODUCT_GID, status: "ACTIVE" } } });
  });

  it("throws on userErrors", async () => {
    const admin = adminReturning({
      data: { productUpdate: { product: null, userErrors: [{ message: "cannot restore" }] } },
    });
    await expect(restoreProduct(admin, PRODUCT_GID, "ACTIVE")).rejects.toThrow(/cannot restore/);
  });
});
