import { describe, expect, it } from "vitest";
import { getPreviewCatalog } from "~/lib/storefront/catalog.server";
import { getStorefrontRecipeReviewCatalog } from "./review-catalog.server";

describe("storefront recipe review catalog", () => {
  it("keeps niche review fixtures isolated from the authenticated preview catalog", async () => {
    const gilt = getStorefrontRecipeReviewCatalog("gilt");
    const roast = getStorefrontRecipeReviewCatalog("roast");

    expect((await gilt.listProducts("demo-shop"))[0]?.title).toBe("Signet Pendant");
    expect((await roast.listProducts("demo-shop"))[0]?.title).toBe("Kayon Mountain Filter Roast");
    expect(gilt).not.toBe(getPreviewCatalog());
  });

  it("exposes two real collection handles and resolvable variants per review recipe", async () => {
    const catalog = getStorefrontRecipeReviewCatalog("volt");
    const collections = await catalog.listCollections("demo-shop");
    const products = await catalog.listProducts("demo-shop");

    expect(collections).toHaveLength(2);
    expect(new Set(collections.map(({ handle }) => handle)).size).toBe(2);
    expect(await catalog.getVariantById?.("demo-shop", products[0]!.variants[0]!.id)).toMatchObject({
      product: { title: "Meridian Headphones" },
      variant: { available: true },
    });
  });
});
