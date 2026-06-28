// app/routes/__tests__/storefront.render.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fixtureCatalog } from "~/lib/storefront/catalog.stub.server";

// getCatalog is mocked file-wide; default returns the REAL fixture so the
// criterion-1 loader tests exercise real fixture data, while the swap test
// (Task 10) overrides it with a second fake. useLoaderData/Outlet are mocked so
// route components render in the node test environment without a router.
const { getCatalogMock, loaderDataRef } = vi.hoisted(() => ({
  getCatalogMock: vi.fn(),
  loaderDataRef: { current: null as unknown },
}));
vi.mock("~/lib/storefront/catalog.server", () => ({ getCatalog: getCatalogMock }));
vi.mock("@remix-run/react", () => ({
  useLoaderData: () => loaderDataRef.current,
  Outlet: () => null,
}));

import StorefrontLayout, { loader as layoutLoader, links } from "../storefront";
import StorefrontHome, { loader as homeLoader } from "../storefront._index";
import StorefrontCollection, { loader as collectionLoader } from "../storefront.collections.$handle";
import StorefrontProduct, { loader as productLoader } from "../storefront.products.$handle";
import type { StorefrontCatalog } from "~/lib/storefront/catalog";

beforeEach(() => {
  getCatalogMock.mockReset();
  getCatalogMock.mockReturnValue(fixtureCatalog);
  loaderDataRef.current = null;
});

function req(url = "https://demo.calderyncompany.com/storefront") {
  return new Request(url);
}

describe("storefront layout", () => {
  it("loads demo store settings (read-only)", async () => {
    const res = await layoutLoader({ request: req(), params: {}, context: {} });
    const data = await res.json();
    expect(data.settings.storeName.length).toBeGreaterThan(0);
    expect(data.settings.palette).toHaveProperty("primary");
  });

  it("links the storefront stylesheet", () => {
    expect(JSON.stringify(links())).toContain("stylesheet");
  });

  it("renders brand chrome", () => {
    loaderDataRef.current = {
      settings: {
        shopId: "demo-shop",
        storeName: "Demo Store",
        logoUrl: "https://img.example/logo.png",
        palette: { primary: "#0f766e", background: "#ffffff", text: "#111827" },
      },
    };
    const html = renderToStaticMarkup(createElement(StorefrontLayout));
    expect(html).toContain("cd-store");
    expect(html).toContain("Demo Store");
  });
});

describe("storefront home", () => {
  it("loads all fixture collections and products (shopId-scoped)", async () => {
    const res = await homeLoader({ request: req(), params: {}, context: {} });
    const data = await res.json();
    expect(data.collections.length).toBe(2);
    expect(data.products.length).toBe(4);
  });

  it("renders a product grid with collection nav", () => {
    loaderDataRef.current = {
      collections: [{ handle: "apparel", title: "Apparel" }],
      products: [
        {
          id: "p1",
          handle: "cotton-tee",
          title: "Cotton Tee",
          description: "",
          images: [{ url: "https://img.example/1.jpg", alt: "Cotton tee" }],
          variants: [{ id: "v1", sku: null, title: "Default", priceCents: 1999, currency: "USD", available: true }],
          collections: ["apparel"],
        },
      ],
    };
    const html = renderToStaticMarkup(createElement(StorefrontHome));
    expect(html).toContain("cd-store__grid");
    expect(html).toContain("Cotton Tee");
    expect(html).toContain("/storefront/collections/apparel");
  });
});

describe("storefront collection", () => {
  it("loads only that collection's products (shopId-scoped)", async () => {
    const res = await collectionLoader({ request: req(), params: { handle: "apparel" }, context: {} });
    const data = await res.json();
    expect(data.handle).toBe("apparel");
    expect(data.title).toBe("Apparel");
    expect(data.products.map((p: { handle: string }) => p.handle).sort()).toEqual([
      "cotton-tee",
      "zip-hoodie",
    ]);
  });

  it("404s when the handle yields no products", async () => {
    await expect(
      collectionLoader({ request: req(), params: { handle: "nope" }, context: {} }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("renders the collection grid", () => {
    loaderDataRef.current = {
      handle: "apparel",
      title: "Apparel",
      products: [
        {
          id: "p1",
          handle: "cotton-tee",
          title: "Cotton Tee",
          description: "",
          images: [],
          variants: [{ id: "v1", sku: null, title: "Default", priceCents: 1999, currency: "USD", available: true }],
          collections: ["apparel"],
        },
      ],
    };
    const html = renderToStaticMarkup(createElement(StorefrontCollection));
    expect(html).toContain("cd-store__grid");
    expect(html).toContain("Apparel");
  });
});

describe("storefront PDP", () => {
  it("loads the product with its variants (shopId-scoped)", async () => {
    const res = await productLoader({ request: req(), params: { handle: "zip-hoodie" }, context: {} });
    const data = await res.json();
    expect(data.product.title).toBe("Zip Hoodie");
    expect(data.product.variants.length).toBe(2);
    expect(data.product.variants[0].priceCents).toBe(5499);
    expect(data.product.variants[0].currency).toBe("USD");
  });

  it("404s when the product handle is unknown", async () => {
    await expect(
      productLoader({ request: req(), params: { handle: "nope" }, context: {} }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("renders an inert Add-to-cart button (no form, no submit)", () => {
    loaderDataRef.current = {
      product: {
        id: "p-hoodie",
        handle: "zip-hoodie",
        title: "Zip Hoodie",
        description: "Fleece-lined zip hoodie.",
        images: [{ url: "https://img.example/h.jpg", alt: "Zip hoodie" }],
        variants: [{ id: "v1", sku: "HOOD-M", title: "Medium", priceCents: 5499, currency: "USD", available: true }],
        collections: ["apparel"],
      },
    };
    const html = renderToStaticMarkup(createElement(StorefrontProduct));
    expect(html).toContain("Add to cart");
    expect(html).toContain('class="cd-pdp__buy"');
    expect(html).not.toContain("<form");
  });
});

describe("storefront swap seam (criterion 2)", () => {
  it("drives all three loaders through a second fake catalog unchanged", async () => {
    const novel = {
      id: "f1",
      handle: "novel",
      title: "Novel",
      description: "",
      images: [],
      variants: [{ id: "fv1", sku: null, title: "Default", priceCents: 1200, currency: "USD", available: true }],
      collections: ["books"],
    };
    const secondFake: StorefrontCatalog = {
      async listCollections() {
        return [{ handle: "books", title: "Books" }];
      },
      async listProducts(_shopId, opts) {
        return !opts?.collection || opts.collection === "books" ? [novel] : [];
      },
      async getProduct(_shopId, handle) {
        return handle === "novel" ? novel : null;
      },
    };
    getCatalogMock.mockReturnValue(secondFake);

    const home = await (await homeLoader({ request: req(), params: {}, context: {} })).json();
    expect(home.collections[0].handle).toBe("books");
    expect(home.products[0].handle).toBe("novel");

    const collection = await (
      await collectionLoader({ request: req(), params: { handle: "books" }, context: {} })
    ).json();
    expect(collection.products[0].handle).toBe("novel");

    const pdp = await (
      await productLoader({ request: req(), params: { handle: "novel" }, context: {} })
    ).json();
    expect(pdp.product.handle).toBe("novel");
  });
});
