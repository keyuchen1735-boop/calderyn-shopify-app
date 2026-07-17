// app/lib/storebuilder/blocks-product.test.ts
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { STARTER_PRODUCT_BLOCKS } from "./blocks-product";
import type { RenderContext } from "./types";
import type { StoreProduct } from "~/lib/storefront/catalog";

const product = (id: string): StoreProduct => ({
  id, handle: `h-${id}`, title: `P${id}`, description: "Desc", images: [{ url: `/i/${id}.jpg`, alt: null }],
  variants: [
    { id: `v-${id}-a`, sku: null, title: "Small", priceCents: 1500, currency: "USD", available: true },
    { id: `v-${id}-b`, sku: null, title: "Large", priceCents: 2000, currency: "USD", available: false },
  ],
  collections: ["summer"],
});
const ctxFor = (p?: StoreProduct, collectionHandle?: string): RenderContext => ({
  data: {
    collections: [{ handle: "summer", title: "Summer" }],
    productsByCollection: { summer: [product("1"), product("2")] },
    productsById: {}, allProducts: [],
  },
  record: { product: p, collection: collectionHandle ? { handle: collectionHandle, title: "Summer" } : undefined },
});
const find = (t: string) => STARTER_PRODUCT_BLOCKS.find((b) => b.type === t)!;
const html = (t: string, ctx: RenderContext) =>
  renderToStaticMarkup(createElement(find(t).Component, { props: find(t).validateProps({}), ctx }));

describe("template + functional blocks", () => {
  it("registers the 6 types with the right flavor + template-only doc kinds", () => {
    expect(STARTER_PRODUCT_BLOCKS.map((b) => b.type).sort()).toEqual(
      ["addToCart", "collectionGrid", "price", "productGallery", "productTitle", "variantPicker"],
    );
    for (const b of STARTER_PRODUCT_BLOCKS) expect(b.allowedDocKinds).toEqual(["template"]);
    const flavor = Object.fromEntries(STARTER_PRODUCT_BLOCKS.map((b) => [b.type, b.flavor]));
    expect(flavor.productGallery).toBe("dynamic");
    expect(flavor.collectionGrid).toBe("dynamic");
    expect(flavor.price).toBe("dynamic");
    expect(flavor.variantPicker).toBe("dynamic");
    expect(flavor.addToCart).toBe("functional");
  });

  it("productGallery renders the current record's product images", () => {
    expect(html("productGallery", ctxFor(product("1")))).toContain("/i/1.jpg");
  });

  it("price renders the current product's primary variant price", () => {
    expect(html("price", ctxFor(product("1")))).toContain("$15.00");
  });

  it("variantPicker lists variant titles + sold-out state (display block)", () => {
    const out = html("variantPicker", ctxFor(product("1")));
    expect(out).toContain("Small");
    expect(out).toContain("Large");
    expect(out).toContain("sold out");
  });

  it("addToCart renders a native post form with only buyable variants", () => {
    const out = html("addToCart", ctxFor(product("1")));
    expect(out).toContain('method="post"');
    expect(out).toContain("v-1-a"); // buyable
    expect(out).not.toContain("v-1-b"); // sold out excluded
  });

  it("collectionGrid renders products of the record collection", () => {
    expect(html("collectionGrid", ctxFor(undefined, "summer"))).toContain("P1");
  });

  it("collectionGrid renders escaped description excerpts", () => {
    const ctx = ctxFor(undefined, "summer");
    ctx.data.productsByCollection.summer = [{
      ...product("1"),
      description: `<script>alert("merchant")</script> ${"detail ".repeat(30)}complete ending`,
    }];

    const out = html("collectionGrid", ctx);
    expect(out).toContain('&lt;script&gt;alert(&quot;merchant&quot;)&lt;/script&gt;');
    expect(out).toContain("…");
    expect(out).not.toContain('<script>alert("merchant")</script>');
    expect(out).not.toContain("complete ending");
  });

  it("template blocks degrade to empty (never throw) with no record", () => {
    expect(() => html("productGallery", { data: ctxFor().data })).not.toThrow();
    expect(() => html("addToCart", { data: ctxFor().data })).not.toThrow();
    expect(() => html("price", { data: ctxFor().data })).not.toThrow();
    expect(() => html("variantPicker", { data: ctxFor().data })).not.toThrow();
    expect(() => html("collectionGrid", { data: ctxFor().data })).not.toThrow();
  });
});
