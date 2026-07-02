// app/routes/__tests__/storefront.render.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { routeArgs, toResponse } from "../../lib/__tests__/_route-test-helpers";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fixtureCatalog } from "~/lib/storefront/catalog.stub.server";
import StorefrontLayout, { loader as layoutLoader, links } from "../storefront";
import StorefrontHome, { loader as homeLoader } from "../storefront._index";
import StorefrontCollection, { loader as collectionLoader } from "../storefront.collections.$handle";
import StorefrontProduct, { loader as productLoader } from "../storefront.products.$handle";
import type { StorefrontCatalog } from "~/lib/storefront/catalog";
import { defaultHomeDocument } from "~/lib/storebuilder/default-doc";

// getCatalog is mocked file-wide; default returns the REAL fixture so the
// criterion-1 loader tests exercise real fixture data, while the swap test
// (Task 10) overrides it with a second fake. useLoaderData/Outlet are mocked so
// route components render in the node test environment without a router.
// vi.mock/vi.hoisted are hoisted above the imports above at transform time, so the
// mocks are registered before the route modules load.
const { getCatalogMock, loaderDataRef } = vi.hoisted(() => ({
  getCatalogMock: vi.fn(),
  loaderDataRef: { current: null as unknown },
}));
vi.mock("~/lib/storefront/catalog.server", () => ({ getCatalog: getCatalogMock }));
vi.mock("react-router", async (importOriginal) => {
  // The real router <Form> needs router context; stub it as a plain <form> so the
  // PDP's add-to-cart form (#2c-1) renders in the node test environment. Server
  // APIs (data, createCookie, ...) stay real via the original module.
  const actual = await importOriginal<Record<string, unknown>>();
  const { createElement } = await import("react");
  return {
    ...actual,
    useLoaderData: () => loaderDataRef.current,
    Outlet: () => null,
    Form: ({ children, method, className }: { children?: unknown; method?: string; className?: string }) =>
      createElement("form", { method, className }, children as never),
  };
});

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
    const res = toResponse(await layoutLoader(routeArgs({ request: req(), params: {}, context: {} })));
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
  it("loads the home block document + resolved fixture data (shopId-scoped)", async () => {
    const res = toResponse(await homeLoader(routeArgs({ request: req(), params: {}, context: {} })));
    const data = await res.json();
    // The demo (non-uuid) shop has no published doc → the never-blank default doc.
    expect(data.doc.blocks.map((b: { type: string }) => b.type)).toEqual(["hero", "productGrid"]);
    // The default doc's product grid uses the `all` source → all 4 fixture products.
    expect(data.data.allProducts.length).toBe(4);
  });

  it("renders the home block document (hero + product grid)", () => {
    loaderDataRef.current = {
      doc: defaultHomeDocument(),
      data: {
        collections: [],
        productsByCollection: {},
        productsById: {},
        allProducts: [
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
      },
    };
    const html = renderToStaticMarkup(createElement(StorefrontHome));
    expect(html).toContain("cd-block--hero");
    expect(html).toContain("cd-store__grid");
    expect(html).toContain("Cotton Tee");
  });
});

describe("storefront collection", () => {
  it("loads only that collection's products (shopId-scoped)", async () => {
    const res = toResponse(await collectionLoader(routeArgs({ request: req(), params: { handle: "apparel" }, context: {} })));
    const data = await res.json();
    expect(data.handle).toBe("apparel");
    expect(data.title).toBe("Apparel");
    expect(data.products.map((p: { handle: string }) => p.handle).sort()).toEqual([
      "cotton-tee",
      "zip-hoodie",
    ]);
  });

  it("404s when the collection handle is unknown", async () => {
    await expect(
      collectionLoader(routeArgs({ request: req(), params: { handle: "nope" }, context: {} })),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("renders a real but empty collection instead of 404ing", async () => {
    getCatalogMock.mockReturnValue({
      async listCollections() {
        return [{ handle: "spring", title: "Spring" }];
      },
      async listProducts() {
        return [];
      },
      async getProduct() {
        return null;
      },
    });
    const res = toResponse(await collectionLoader(routeArgs({ request: req(), params: { handle: "spring" }, context: {} })));
    const data = await res.json();
    expect(data.title).toBe("Spring");
    expect(data.products).toEqual([]);
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
    const res = toResponse(await productLoader(routeArgs({ request: req(), params: { handle: "zip-hoodie" }, context: {} })));
    const data = await res.json();
    expect(data.product.title).toBe("Zip Hoodie");
    expect(data.product.variants.length).toBe(2);
    expect(data.product.variants[0].priceCents).toBe(5499);
    expect(data.product.variants[0].currency).toBe("USD");
  });

  it("404s when the product handle is unknown", async () => {
    await expect(
      productLoader(routeArgs({ request: req(), params: { handle: "nope" }, context: {} })),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("renders a working Add-to-cart form that POSTs the variant", () => {
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
    // The button is no longer inert: it's a real POST form carrying the variant (#2c-1).
    expect(html).toMatch(/<form[^>]*method="post"/i);
    expect(html).toContain('name="variantId"');
    expect(html).toContain('value="v1"');
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

    const home = await toResponse(
      await homeLoader(routeArgs({ request: req(), params: {}, context: {} })),
    ).json();
    // Home now returns { doc, data }; the default doc's `all` grid pulls products from the swapped catalog.
    expect(home.data.allProducts[0].handle).toBe("novel");

    const collection = await toResponse(
      await collectionLoader(routeArgs({ request: req(), params: { handle: "books" }, context: {} })),
    ).json();
    expect(collection.products[0].handle).toBe("novel");

    const pdp = await toResponse(
      await productLoader(routeArgs({ request: req(), params: { handle: "novel" }, context: {} })),
    ).json();
    expect(pdp.product.handle).toBe("novel");
  });
});
