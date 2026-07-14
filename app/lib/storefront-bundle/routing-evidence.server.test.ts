import { describe, expect, it, vi } from "vitest";
import { STORE_TEMPLATE_REGISTRY } from "./registry";
import { buildCatalogRoutingEvidence, type CatalogRoutingSource } from "./routing-evidence.server";

describe("server-side catalog routing evidence", () => {
  it("uses active public fields only, normalizes/deduplicates, deterministically caps, and fingerprints", async () => {
    const source: CatalogRoutingSource = {
      listActiveProducts: vi.fn(async () => [
        { id: "002", title: "  Crème  Serum ", productType: "Skin-Care", tags: ["Clean", "clean", "Sensitive"] },
        { id: "001", title: "Refill Soap", productType: "Body", tags: ["Low Waste"] },
      ]),
      listOptionNames: vi.fn(async () => ["Size", " size ", "Scent"]),
      listCollections: vi.fn(async () => [
        { id: "b", title: "Sensitive Skin" },
        { id: "a", title: "Refills" },
      ]),
    };
    const first = await buildCatalogRoutingEvidence("shop-1", STORE_TEMPLATE_REGISTRY, source);
    const second = await buildCatalogRoutingEvidence("shop-1", STORE_TEMPLATE_REGISTRY, source);
    expect(first).toEqual(second);
    expect(first).toEqual({
      productTitles: ["refill soap", "crème serum"],
      productTypes: ["body", "skin care"],
      productTags: ["low waste", "clean", "sensitive"],
      optionNames: ["size", "scent"],
      collectionTitles: ["refills", "sensitive skin"],
      fingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    expect(source.listActiveProducts).toHaveBeenCalledWith("shop-1", 200);
    expect(source.listOptionNames).toHaveBeenCalledWith("shop-1", ["001", "002"], 100);
    expect(source.listCollections).toHaveBeenCalledWith("shop-1", 100);
  });

  it("caps every evidence field after stable ordering", async () => {
    const source: CatalogRoutingSource = {
      listActiveProducts: async (_shopId, limit) =>
        Array.from({ length: limit + 50 }, (_, index) => ({
          id: String(index).padStart(4, "0"),
          title: `Product ${index}`,
          productType: `Type ${index}`,
          tags: [`Tag ${index}`, `Extra ${index}`],
        })),
      listOptionNames: async () => Array.from({ length: 150 }, (_, index) => `Option ${index}`),
      listCollections: async () => Array.from({ length: 150 }, (_, index) => ({ id: String(index), title: `Collection ${index}` })),
    };
    const result = await buildCatalogRoutingEvidence("shop-1", STORE_TEMPLATE_REGISTRY, source);
    expect(result.productTitles).toHaveLength(200);
    expect(result.productTypes).toHaveLength(100);
    expect(result.productTags).toHaveLength(200);
    expect(result.optionNames).toHaveLength(100);
    expect(result.collectionTitles).toHaveLength(100);
  });

  it("changes the fingerprint when routing or registry versions change", async () => {
    const source: CatalogRoutingSource = {
      listActiveProducts: async () => [],
      listOptionNames: async () => [],
      listCollections: async () => [],
    };
    const first = await buildCatalogRoutingEvidence("shop-1", STORE_TEMPLATE_REGISTRY, source);
    const second = await buildCatalogRoutingEvidence(
      "shop-1",
      { ...STORE_TEMPLATE_REGISTRY, routingVersion: STORE_TEMPLATE_REGISTRY.routingVersion + 1 },
      source,
    );
    expect(first.fingerprint).not.toBe(second.fingerprint);
  });
});
