// app/lib/storebuilder/blocks.test.ts
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { STARTER_BLOCKS } from "./blocks";
import type { RenderContext } from "./types";
import type { StoreProduct } from "~/lib/storefront/catalog";

const product = (id: string): StoreProduct => ({
  id, handle: `h-${id}`, title: `P${id}`, description: "", images: [{ url: `/i/${id}.jpg`, alt: null }],
  variants: [{ id: `v-${id}`, sku: null, title: "Default", priceCents: 1000, currency: "USD", available: true }],
  collections: ["summer"],
});
const ctx = (): RenderContext => ({
  data: {
    collections: [{ handle: "summer", title: "Summer" }],
    productsByCollection: { summer: [product("1")] },
    productsById: { "1": product("1") },
    allProducts: [product("1")],
  },
});

describe("starter blocks", () => {
  it("registers exactly the 6 starter types with stable flavors", () => {
    expect(STARTER_BLOCKS.map((b) => b.type).sort()).toEqual(
      ["button", "collectionList", "hero", "image", "productGrid", "richText"],
    );
    const flavor = Object.fromEntries(STARTER_BLOCKS.map((b) => [b.type, b.flavor]));
    expect(flavor.hero).toBe("static");
    expect(flavor.productGrid).toBe("dynamic");
  });

  it("validateProps fills defaults and coerces bad input without throwing on recoverable shape", () => {
    const hero = STARTER_BLOCKS.find((b) => b.type === "hero")!;
    const clean = hero.validateProps({ headline: "Hi" });
    expect(clean).toMatchObject({ headline: "Hi" });
    expect(typeof (clean as { subhead: string }).subhead).toBe("string"); // default applied
  });

  it("productGrid.catalogRefs surfaces the collection handle it binds to", () => {
    const grid = STARTER_BLOCKS.find((b) => b.type === "productGrid")!;
    const props = grid.validateProps({ source: { kind: "collection", handle: "summer" } });
    expect(grid.catalogRefs(props)).toEqual({ productIds: [], collectionHandles: ["summer"] });
  });

  it("renders productGrid against resolved data", () => {
    const grid = STARTER_BLOCKS.find((b) => b.type === "productGrid")!;
    const props = grid.validateProps({ source: { kind: "all" } });
    const html = renderToStaticMarkup(createElement(grid.Component, { props, ctx: ctx() }));
    expect(html).toContain("P1");
    expect(html).toContain("/i/1.jpg");
  });
});
