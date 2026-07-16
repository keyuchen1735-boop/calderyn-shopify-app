// app/routes/__tests__/storefront.collection-template.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fixtureCatalog } from "~/lib/storefront/catalog.stub.server";
import { decodeProductPageCursor, encodeProductPageCursor } from "~/lib/storefront/catalog";
import StorefrontCollection, { loader } from "../storefront.collections.$handle";
import { requireLegacyLoaderData } from "./storefront-runtime-test-data";

const { getCatalogMock, loadPublishedMock, loaderDataRef } = vi.hoisted(() => ({
  getCatalogMock: vi.fn(), loadPublishedMock: vi.fn(), loaderDataRef: { current: null as unknown },
}));
vi.mock("~/lib/storefront/catalog.server", () => ({ getCatalog: getCatalogMock }));
vi.mock("~/lib/storebuilder/page-document.server", () => ({ loadPublishedDoc: loadPublishedMock }));
vi.mock("@remix-run/react", () => ({ useLoaderData: () => loaderDataRef.current }));

beforeEach(() => {
  getCatalogMock.mockReset().mockReturnValue(fixtureCatalog);
  loadPublishedMock.mockReset();
  loaderDataRef.current = null;
});
// Note: fixture catalog has "apparel" and "accessories"; plan used "summer" which 404s.
const args = (handle: string) => ({ request: new Request("https://demo.calderyncompany.com/storefront/collections/" + handle), params: { handle }, context: {} } as never);
const argsForUrl = (url: string) => ({ request: new Request(url), params: { handle: "apparel" }, context: {} } as never);

describe("collection route on the block spine", () => {
  it("keeps a published collection template on the 24-product public page", async () => {
    const products = Array.from({ length: 30 }, (_, index) => ({
      id: `product-${index}`,
      handle: `product-${index}`,
      title: `Product ${index}`,
      description: `Description ${index}`,
      images: [], variants: [], collections: ["apparel"],
    }));
    getCatalogMock.mockReturnValue({
      listCollections: async () => [{ handle: "apparel", title: "Apparel" }],
      listProductPage: async () => ({ items: products.slice(0, 24), nextCursor: "next-page" }),
      listProducts: async () => { throw new Error("collection template must use the bounded page"); },
      getProduct: async () => null,
    });
    loadPublishedMock.mockResolvedValue({
      kind: "template", pageKey: "collection",
      blocks: [{ id: "cg", type: "collectionGrid", layout: { x: 0, y: 0, w: 12, h: 6 }, props: {} }],
    });

    const data = requireLegacyLoaderData(await (await loader(args("apparel"))).json());
    expect(data.data).not.toBeNull();
    expect(data.data!.productsByCollection.apparel).toHaveLength(24);
    expect(data.nextCursor).toBe("next-page");
  });

  it("renders a published collection template against the record", async () => {
    loadPublishedMock.mockResolvedValue({
      kind: "template", pageKey: "collection",
      blocks: [{ id: "cg", type: "collectionGrid", layout: { x: 0, y: 0, w: 12, h: 6 }, props: {} }],
    });
    const data = requireLegacyLoaderData(await (await loader(args("apparel"))).json());
    expect(data.doc).toBeTruthy();
    loaderDataRef.current = data;
    expect(renderToStaticMarkup(createElement(StorefrontCollection))).toContain("cd-store__grid");
  });

  it("reaches all 61 products once through the next links rendered after a published template", async () => {
    const products = Array.from({ length: 61 }, (_, index) => {
      const suffix = index.toString().padStart(2, "0");
      return {
        id: `product-${suffix}`, handle: `product-${suffix}`, title: `Product ${suffix}`,
        description: `Description ${suffix}`, images: [], variants: [], collections: ["apparel"],
      };
    });
    getCatalogMock.mockReturnValue({
      listCollections: async () => [{ handle: "apparel", title: "Apparel" }],
      listProductPage: async (_shopId: string, opts: { cursor?: string | null; limit: number }) => {
        const decoded = opts.cursor ? decodeProductPageCursor(opts.cursor) : null;
        const offset = decoded ? products.findIndex((entry) => entry.id === decoded.id) + 1 : 0;
        const items = products.slice(offset, offset + opts.limit);
        const last = items.at(-1);
        return {
          items,
          nextCursor: last && offset + items.length < products.length
            ? encodeProductPageCursor(last.title, last.id)
            : null,
        };
      },
      listProducts: async () => { throw new Error("published template must use the bounded route page"); },
      getProduct: async () => null,
    });
    loadPublishedMock.mockResolvedValue({
      kind: "template", pageKey: "collection",
      blocks: [{ id: "cg", type: "collectionGrid", layout: { x: 0, y: 0, w: 12, h: 6 }, props: {} }],
    });
    const seen: string[] = [];
    let url = "https://demo.calderyncompany.com/storefront/collections/apparel";

    for (let page = 0; page < 4; page += 1) {
      const data = requireLegacyLoaderData(await (await loader(argsForUrl(url))).json());
      loaderDataRef.current = data;
      const markup = renderToStaticMarkup(createElement(StorefrontCollection));
      seen.push(...[...markup.matchAll(/class="cd-product-card__title">([^<]+)</g)].map((match) => match[1]));
      const nextAnchor = markup.match(/<a\b[^>]*\brel="next"[^>]*>/)?.[0];
      const href = nextAnchor?.match(/\bhref="([^"]+)"/)?.[1] ?? null;
      if (!href) break;
      url = new URL(href.replaceAll("&amp;", "&"), url).href;
    }

    expect(seen).toEqual(products.map((entry) => entry.title));
    expect(new Set(seen).size).toBe(61);
  });

  it("falls back to the legacy grid when there is no template doc", async () => {
    loadPublishedMock.mockResolvedValue(null);
    const data = requireLegacyLoaderData(await (await loader(args("apparel"))).json());
    expect(data.doc).toBeNull();
    loaderDataRef.current = data;
    expect(renderToStaticMarkup(createElement(StorefrontCollection))).toContain("cd-store__grid");
  });
});
