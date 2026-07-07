// app/routes/__tests__/storefront.meta.test.ts
import { describe, it, expect } from "vitest";
import { meta as layoutMeta } from "../storefront";
import { meta as homeMeta } from "../storefront._index";
import { meta as collectionMeta } from "../storefront.collections.$handle";
import { meta as productMeta } from "../storefront.products.$handle";

type Tag = Record<string, unknown>;

function assertSeoTags(tags: Tag[]) {
  expect(tags.some((t) => "title" in t && typeof t.title === "string" && t.title.length > 0)).toBe(true);
  expect(tags.some((t) => t.name === "description")).toBe(true);
  expect(tags.some((t) => t.property === "og:title")).toBe(true);
}

// Home/collection/product metas are now pure passthroughs of the seoMeta the loader
// already built (see app/lib/seo). These fixtures stand in for that loader output the
// way Remix supplies it at runtime via the `data` arg.
describe("storefront SEO meta", () => {
  it("layout meta has title + description + og:title", () => {
    assertSeoTags(layoutMeta({ data: { settings: { storeName: "Acme Goods" } } } as never) as Tag[]);
  });

  it("home meta passes through the loader-built seoMeta", () => {
    const seoMeta = [
      { title: "Acme Goods" },
      { name: "description", content: "Browse Acme Goods." },
      { property: "og:title", content: "Acme Goods" },
    ];
    const tags = homeMeta({ data: { doc: null, data: null, seoMeta } } as never) as Tag[];
    assertSeoTags(tags);
    expect(JSON.stringify(tags)).toContain("Acme Goods");
  });

  it("home meta falls back to a bare title when there is no loader data yet", () => {
    expect(homeMeta({} as never)).toEqual([{ title: "Store" }]);
  });

  it("collection meta passes through the loader-built seoMeta", () => {
    const seoMeta = [
      { title: "Apparel · Acme Goods" },
      { name: "description", content: "Browse Apparel at Acme Goods." },
      { property: "og:title", content: "Apparel · Acme Goods" },
    ];
    const tags = collectionMeta({
      data: { handle: "apparel", title: "Apparel", products: [], seoMeta },
    } as never) as Tag[];
    assertSeoTags(tags);
    expect(JSON.stringify(tags)).toContain("Apparel");
  });

  it("product meta passes through the loader-built seoMeta", () => {
    const product = {
      id: "p1",
      handle: "zip-hoodie",
      title: "Zip Hoodie",
      description: "Fleece-lined zip hoodie.",
      images: [],
      variants: [],
      collections: ["apparel"],
    };
    const seoMeta = [
      { title: "Zip Hoodie · Acme Goods" },
      { name: "description", content: "Fleece-lined zip hoodie." },
      { property: "og:title", content: "Zip Hoodie · Acme Goods" },
    ];
    const tags = productMeta({ data: { product, seoMeta } } as never) as Tag[];
    assertSeoTags(tags);
    expect(JSON.stringify(tags)).toContain("Zip Hoodie");
  });
});
