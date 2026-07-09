// app/lib/storebuilder/resolve-data.server.test.ts
import { describe, it, expect } from "vitest";
import { resolveRenderData } from "./resolve-data.server";
import type { BlockDocument } from "./types";
import type { StorefrontCatalog, StoreProduct } from "~/lib/storefront/catalog";

const p = (id: string, collection: string): StoreProduct => ({
  id, handle: `h-${id}`, title: `P${id}`, description: "", images: [], variants: [], collections: [collection],
});
const fakeCatalog = (): StorefrontCatalog => ({
  listCollections: async () => [{ handle: "summer", title: "Summer" }, { handle: "winter", title: "Winter" }],
  listProducts: async (_s, opts) => (opts?.collection ? [p("1", opts.collection)] : [p("1", "summer"), p("2", "winter")]),
  getProduct: async (_s, handle) => p(handle.replace("h-", ""), "summer"),
});

describe("resolveRenderData", () => {
  it("loads all collections and all products once, keyed for the renderer", async () => {
    const doc: BlockDocument = { kind: "singleton", pageKey: "home", blocks: [
      { id: "g", type: "productGrid", layout: { x: 0, y: 0, w: 12, h: 6 }, props: { source: { kind: "all" } } },
      { id: "c", type: "collectionList", layout: { x: 0, y: 6, w: 12, h: 1 }, props: {} },
    ] };
    const data = await resolveRenderData(doc, "shop", fakeCatalog());
    expect(data.collections.map((c) => c.handle)).toEqual(["summer", "winter"]);
    expect(data.allProducts).toHaveLength(2);
  });

  it("loads products for a collection that a productGrid binds to", async () => {
    const doc: BlockDocument = { kind: "singleton", pageKey: "home", blocks: [
      { id: "g", type: "productGrid", layout: { x: 0, y: 0, w: 12, h: 6 }, props: { source: { kind: "collection", handle: "summer" } } },
    ] };
    const data = await resolveRenderData(doc, "shop", fakeCatalog());
    expect(data.productsByCollection.summer).toHaveLength(1);
  });

  it("loads the record collection's products for a collectionGrid template", async () => {
    const doc: BlockDocument = { kind: "template", pageKey: "collection", blocks: [
      { id: "cg", type: "collectionGrid", layout: { x: 0, y: 0, w: 12, h: 6 }, props: {} },
    ] };
    const data = await resolveRenderData(doc, "shop", fakeCatalog(), { collection: { handle: "winter", title: "Winter" } });
    expect(data.productsByCollection.winter).toHaveLength(1);
  });

  it("resolves an explicit-ids grid by REAL product id (no handle convention), preserving unknown-id drops", async () => {
    // Regression: ids used to resolve via a fixture-only `h-<id>` handle lookup that matched
    // nothing in production, so every curated "featured picks" grid rendered empty.
    const doc: BlockDocument = { kind: "singleton", pageKey: "home", blocks: [
      { id: "g", type: "productGrid", layout: { x: 0, y: 0, w: 12, h: 6 }, props: { source: { kind: "ids", ids: ["2", "deleted-since"] } } },
    ] };
    const catalog: StorefrontCatalog = {
      ...fakeCatalog(),
      // getProduct throwing proves the id path never touches the handle lookup.
      getProduct: async () => { throw new Error("id resolution must not use getProduct"); },
    };
    const data = await resolveRenderData(doc, "shop", catalog);
    expect(data.productsById["2"]?.title).toBe("P2");
    expect(data.productsById["deleted-since"]).toBeUndefined();
  });

  it("floats weather-relevant products to the top of the all-products grid for the visitor's condition", async () => {
    const prod = (id: string, title: string): StoreProduct => ({
      id, handle: `h-${id}`, title, description: "", images: [], variants: [], collections: [],
    });
    const catalog: StorefrontCatalog = {
      listCollections: async () => [],
      listProducts: async () => [prod("mug", "Coffee Mug"), prod("rain", "Rain Jacket")], // neutral first by default
      getProduct: async () => prod("mug", "Coffee Mug"),
    };
    const doc: BlockDocument = { kind: "singleton", pageKey: "home", blocks: [
      { id: "g", type: "productGrid", layout: { x: 0, y: 0, w: 12, h: 6 }, props: { source: { kind: "all" } } },
    ] };
    // storm → the Rain Jacket (storm cue in its title) floats above the neutral mug.
    const stormy = await resolveRenderData(doc, "shop", catalog, undefined, "storm");
    expect(stormy.allProducts.map((x) => x.id)).toEqual(["rain", "mug"]);
    // neutral (default) → order unchanged.
    const mild = await resolveRenderData(doc, "shop", catalog);
    expect(mild.allProducts.map((x) => x.id)).toEqual(["mug", "rain"]);
  });
});
