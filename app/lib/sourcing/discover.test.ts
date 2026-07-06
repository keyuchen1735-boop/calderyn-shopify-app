// app/lib/sourcing/discover.test.ts
import { describe, it, expect } from "vitest";
import { buildProductInput } from "./discover.server";
import type { NormalizedSourceProduct } from "./types";

const src: NormalizedSourceProduct = {
  provider: "fixture",
  externalId: "fx-1",
  title: "Mini Blender",
  category: "Kitchen",
  imageUrls: ["https://x/1.jpg", "https://x/2.jpg"],
  unitCostCents: 800,
  moq: 1,
  leadTimeDays: 9,
  supplier: {
    provider: "fixture",
    externalSupplierId: "sup-a",
    name: "HomeGoods",
    reliabilityScore: 0.9,
  },
  signals: [],
};

describe("buildProductInput", () => {
  it("creates an active product with a single priced+sourced variant", () => {
    const input = buildProductInput(src);
    expect(input.status).toBe("active");
    expect(input.vendor).toBe("HomeGoods");
    expect(input.variants).toHaveLength(1);
    expect(input.variants[0].unitCostCents).toBe(800);
    expect(input.variants[0].retailPriceCents).toBe(2000); // 2.5x
    expect(input.variants[0].requiresShipping).toBe(true);
  });
});
