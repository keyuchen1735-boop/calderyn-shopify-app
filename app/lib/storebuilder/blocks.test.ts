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

  it("validators tolerate null/undefined/non-object input without throwing", () => {
    for (const b of STARTER_BLOCKS) {
      expect(() => b.validateProps(null)).not.toThrow();
      expect(() => b.validateProps(undefined)).not.toThrow();
      expect(() => b.validateProps(42)).not.toThrow();
      expect(() => b.validateProps("x")).not.toThrow();
    }
  });

  it("button rejects a javascript: href, falling back to a safe default", () => {
    const button = STARTER_BLOCKS.find((b) => b.type === "button")!;
    const clean = button.validateProps({ label: "x", href: "javascript:alert(1)" }) as { href: string };
    expect(clean.href).toBe("/storefront");
    const ok = button.validateProps({ href: "/products" }) as { href: string };
    expect(ok.href).toBe("/products");
  });

  it("renders collectionList against resolved data", () => {
    const cl = STARTER_BLOCKS.find((b) => b.type === "collectionList")!;
    const html = renderToStaticMarkup(createElement(cl.Component, { props: cl.validateProps({}), ctx: ctx() }));
    expect(html).toContain("Summer");
  });
});
