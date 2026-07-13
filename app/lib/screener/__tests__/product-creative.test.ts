import { describe, expect, it } from "vitest";
import { buildProductCreative } from "../product-creative.server";

describe("buildProductCreative", () => {
  it("shapes a complete CreativeInput from a product", () => {
    const c = buildProductCreative({
      title: "Peak Wool Beanie",
      description: "Warm merino beanie for cold trailheads.",
      imageUrl: "https://cdn.example.com/beanie.jpg",
      productUrl: "https://acme.calderyncompany.com/storefront/products/peak-wool-beanie",
      price: "$32",
    });
    expect(c.headline).toBe("Peak Wool Beanie");
    expect(c.primaryText).toContain("merino");
    expect(c.cta).toBe("SHOP_NOW");
    expect(c.destinationUrl).toContain("/storefront/products/peak-wool-beanie");
    expect(c.imageUrl).toBe("https://cdn.example.com/beanie.jpg");
    expect(c.audience).toBe("");
  });

  it("tolerates a missing description and image", () => {
    const c = buildProductCreative({ title: "T", description: null, imageUrl: null, productUrl: "https://x/p", price: null });
    expect(c.primaryText.length).toBeGreaterThan(0);
    expect(c.imageUrl).toBeNull();
  });
});
