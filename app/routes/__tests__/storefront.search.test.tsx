import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { compileBundle } from "~/lib/storefront-compiler/compile";
import { VALID_BUNDLE_SOURCE } from "~/lib/storefront-compiler/__fixtures__/valid-bundle";
import type { StorefrontCatalog, StoreProduct } from "~/lib/storefront/catalog";
import { resolvePublicData, type PublicRouteContext } from "~/lib/storefront-runtime/public-data.server";

const { loaderDataRef, resolveRuntime1RouteMock } = vi.hoisted(() => ({
  loaderDataRef: { current: null as unknown },
  resolveRuntime1RouteMock: vi.fn(),
}));

vi.mock("@remix-run/react", () => ({ useLoaderData: () => loaderDataRef.current }));
vi.mock("~/lib/storefront/shop.server", () => ({ resolveStorefrontShop: vi.fn(async () => "shop-a") }));
vi.mock("~/lib/storefront-runtime/release-resolution.server", () => ({
  hasRuntime1Storefront: vi.fn(async () => true),
  resolveRuntime1Route: (...args: unknown[]) => resolveRuntime1RouteMock(...args),
}));

// eslint-disable-next-line import/first -- route import follows hoisted loader mocks
import StorefrontSearch, { loader } from "../storefront.search";

describe("storefront search route", () => {
  it("exists as the complete storefront search surface", () => {
    expect(loader).toBeTypeOf("function");
  });

  it("reaches all 61 uncollected products once through rendered next links", async () => {
    const products = Array.from({ length: 61 }, (_, index): StoreProduct => {
      const suffix = index.toString().padStart(2, "0");
      return {
        id: `product-${suffix}`,
        handle: `product-${suffix}`,
        title: `Product ${suffix}`,
        description: `Description ${suffix}`,
        images: [],
        variants: [],
        collections: [],
      };
    });
    const catalog: StorefrontCatalog = {
      listProductPage: vi.fn(async (_shopId, options) => {
        const offset = options.cursor ? Number(options.cursor) : 0;
        const items = products.slice(offset, offset + options.limit);
        const next = offset + items.length;
        return { items, nextCursor: next < products.length ? String(next) : null };
      }),
      listProducts: vi.fn(async (_shopId, options) => {
        const ids = new Set(options?.ids ?? []);
        return products.filter((product) => ids.has(product.id)).slice(0, options?.limit);
      }),
      getProduct: vi.fn(async () => null),
      listCollections: vi.fn(async () => []),
    };
    const source = structuredClone(VALID_BUNDLE_SOURCE);
    source.routes.search.html = `<main data-cd-repeat="search.results"><article data-cd-key="product.id" data-cd-text="product.title"></article></main>`;
    const bundle = compileBundle(source).bundle;
    resolveRuntime1RouteMock.mockImplementation(async ({ route }: { route: PublicRouteContext }) => ({
      runtime: 1,
      bundleId: "bundle-search",
      artifactHash: "sha256:bundle-search",
      bundle,
      data: await resolvePublicData({
        shopId: "shop-a",
        requiredData: [{ kind: "searchResults", limit: 24 }],
        route,
      }, {
        catalog,
        settingsLoader: async () => ({
          shopId: "shop-a",
          storeName: "Search store",
          logoUrl: null,
          palette: { primary: "#000", background: "#fff", text: "#111" },
          voiceTagline: "",
          vibe: "minimal",
          typeStyle: "editorial",
          density: "roomy",
        }),
      }),
    }));
    const seen: string[] = [];
    let url = "https://demo.calderyncompany.com/storefront/search?q=product&sort=title_asc&limit=24";

    for (let page = 0; page < 4; page += 1) {
      const response = await loader({ request: new Request(url), params: {}, context: {} } as never);
      loaderDataRef.current = await response.json();
      const markup = renderToStaticMarkup(createElement(StorefrontSearch));
      seen.push(...[...markup.matchAll(/>Product (\d{2})</g)].map((match) => `Product ${match[1]}`));
      const nextAnchor = markup.match(/<a\b[^>]*\brel="next"[^>]*>/)?.[0];
      const href = nextAnchor?.match(/\bhref="([^"]+)"/)?.[1] ?? null;
      if (!href) break;
      expect(href).toContain("q=product");
      expect(href).toContain("sort=title_asc");
      url = new URL(href.replaceAll("&amp;", "&"), url).href;
    }

    expect(seen).toEqual(products.map((product) => product.title));
    expect(new Set(seen).size).toBe(61);
  });
});
