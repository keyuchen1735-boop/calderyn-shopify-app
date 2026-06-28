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
