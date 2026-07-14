import { describe, expect, it } from "vitest";
import { assembleStorefrontContext } from "./context.server";

describe("assembleStorefrontContext", () => {
  it("builds a deterministic bounded public snapshot while preserving collection coverage", async () => {
    const context = await assembleStorefrontContext({
      shopId: "11111111-1111-4111-8111-111111111111",
      prompt: "  Build <script>alert(1)</script> a sculptural shop  ",
      referenceImages: [{ assetKey: "owned/reference", mediaType: "image/webp" }],
    }, {
      async getStore() {
        return { name: " Northline\u0000 ", logoAssetKey: "owned/logo", publicBrandAssetKeys: ["owned/logo"] };
      },
      async listCollections() {
        return [
          { id: "c2", handle: "chairs", title: " Chairs ", productCount: 1 },
          { id: "c1", handle: "lights", title: " Lights ", productCount: 20 },
        ];
      },
      async listProducts() {
        return Array.from({ length: 30 }, (_, index) => ({
          id: `p${String(index).padStart(2, "0")}`,
          handle: `product-${index}`,
          title: `Product ${index}`,
          productType: index % 2 ? "Chair" : "Light",
          tags: ["public", `tag-${index}`],
          optionNames: ["Finish"],
          priceMin: 1000,
          priceMax: 2000,
          currency: "USD",
          availability: "available" as const,
          collectionIds: [index === 29 ? "c2" : "c1"],
          images: [{ assetKey: `catalog/${index}`, aspectRatio: 1.2 }],
          supplierCost: 1,
          privateNotes: "never expose",
        }));
      },
      async listReusableAssets() {
        return [{ assetKey: "owned/editorial", mediaType: "image/webp", width: 1200, height: 900 }];
      },
    }, { maxProducts: 4, maxCollections: 4, maxPromptChars: 200 });

    expect(context.collections.map((item) => item.id)).toEqual(["c1", "c2"]);
    expect(context.products).toHaveLength(4);
    expect(context.products.some((item) => item.collectionIds?.includes("c2"))).toBe(true);
    expect(JSON.stringify(context)).not.toMatch(/supplierCost|privateNotes|never expose/);
    expect(context.store.name).toBe("Northline");
    expect(context.prompt).toContain("<script>");
    expect(context.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("produces the same fingerprint regardless of source row order", async () => {
    const products = [
      { id: "b", handle: "b", title: "B", productType: null, tags: [], optionNames: [], priceMin: 1, priceMax: 1, currency: "USD", availability: "available" as const, collectionIds: [], images: [] },
      { id: "a", handle: "a", title: "A", productType: null, tags: [], optionNames: [], priceMin: 1, priceMax: 1, currency: "USD", availability: "available" as const, collectionIds: [], images: [] },
    ];
    const makeSource = (reversed: boolean) => ({
      getStore: async () => ({ name: "Store", logoAssetKey: null, publicBrandAssetKeys: [] }),
      listCollections: async () => [],
      listProducts: async () => reversed ? products.slice().reverse() : products,
      listReusableAssets: async () => [],
    });
    const input = { shopId: "11111111-1111-4111-8111-111111111111", prompt: "Original", referenceImages: [] };
    expect((await assembleStorefrontContext(input, makeSource(false))).fingerprint)
      .toBe((await assembleStorefrontContext(input, makeSource(true))).fingerprint);
  });
});
