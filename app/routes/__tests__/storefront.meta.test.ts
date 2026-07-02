// app/routes/__tests__/storefront.meta.test.ts
import { describe, it, expect } from "vitest";
import { meta as layoutMeta } from "../storefront";
import { meta as homeMeta } from "../storefront._index";
import { meta as collectionMeta } from "../storefront.collections.$handle";
import { meta as productMeta } from "../storefront.products.$handle";

type Tag = Record<string, unknown>;

// Child metas read the tenant's store name off the layout match (matches arg),
// the way Remix supplies it at runtime.
const MATCHES = [
  { id: "routes/storefront", data: { settings: { storeName: "Acme Goods" } } },
];

function assertSeoTags(tags: Tag[]) {
  expect(tags.some((t) => "title" in t && typeof t.title === "string" && t.title.length > 0)).toBe(true);
  expect(tags.some((t) => t.name === "description")).toBe(true);
  expect(tags.some((t) => t.property === "og:title")).toBe(true);
}

describe("storefront SEO meta", () => {
  it("layout meta has title + description + og:title", () => {
    assertSeoTags(layoutMeta({ data: { settings: { storeName: "Acme Goods" } } } as never) as Tag[]);
  });

  it("home meta has title + description + og:title", () => {
    const tags = homeMeta({ matches: MATCHES } as never) as Tag[];
    assertSeoTags(tags);
    expect(JSON.stringify(tags)).toContain("Acme Goods");
  });

  it("collection meta uses the collection title", () => {
    const tags = collectionMeta({
      data: { handle: "apparel", title: "Apparel", products: [] },
      matches: MATCHES,
    } as never) as Tag[];
    assertSeoTags(tags);
    expect(JSON.stringify(tags)).toContain("Apparel");
  });

  it("product meta uses the product title", () => {
    const product = {
      id: "p1",
      handle: "zip-hoodie",
      title: "Zip Hoodie",
      description: "Fleece-lined zip hoodie.",
      images: [],
      variants: [],
      collections: ["apparel"],
    };
    const tags = productMeta({ data: { product }, matches: MATCHES } as never) as Tag[];
    assertSeoTags(tags);
    expect(JSON.stringify(tags)).toContain("Zip Hoodie");
  });
});
