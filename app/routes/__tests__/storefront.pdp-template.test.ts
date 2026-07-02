// app/routes/__tests__/storefront.pdp-template.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { toResponse } from "../../lib/__tests__/_route-test-helpers";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fixtureCatalog } from "~/lib/storefront/catalog.stub.server";
import StorefrontProduct, { loader } from "../storefront.products.$handle";

const { getCatalogMock, loadPublishedMock, loaderDataRef } = vi.hoisted(() => ({
  getCatalogMock: vi.fn(), loadPublishedMock: vi.fn(), loaderDataRef: { current: null as unknown },
}));
vi.mock("~/lib/storefront/catalog.server", () => ({ getCatalog: getCatalogMock }));
vi.mock("~/lib/storebuilder/page-document.server", () => ({ loadPublishedDoc: loadPublishedMock }));
vi.mock("react-router", async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), useLoaderData: () => loaderDataRef.current, Form: (p: Record<string, unknown>) => createElement("form", p) }));

beforeEach(() => {
  getCatalogMock.mockReset().mockReturnValue(fixtureCatalog);
  loadPublishedMock.mockReset();
  loaderDataRef.current = null;
});
const firstHandle = async () => (await fixtureCatalog.listProducts("demo-shop"))[0].handle;
const args = (handle: string) => ({ request: new Request("https://demo.calderyncompany.com/storefront/products/" + handle), params: { handle }, context: {} } as never);

describe("PDP route on the block spine", () => {
  it("renders a published PDP template bound to the product, with the buy form", async () => {
    const handle = await firstHandle();
    loadPublishedMock.mockResolvedValue({
      kind: "template", pageKey: "pdp",
      blocks: [
        { id: "g", type: "productGallery", layout: { x: 0, y: 0, w: 6, h: 6 }, props: {} },
        { id: "atc", type: "addToCart", layout: { x: 6, y: 3, w: 6, h: 1 }, props: {} },
      ],
    });
    const data = await toResponse(await loader(args(handle))).json();
    expect(data.doc).toBeTruthy();
    loaderDataRef.current = data;
    const out = renderToStaticMarkup(createElement(StorefrontProduct));
    expect(out).toContain("cd-block--gallery");
    expect(out).toContain('method="post"');
  });

  it("falls back to the legacy PDP when there is no template doc", async () => {
    const handle = await firstHandle();
    loadPublishedMock.mockResolvedValue(null);
    const data = await toResponse(await loader(args(handle))).json();
    expect(data.doc).toBeNull();
    loaderDataRef.current = data;
    expect(renderToStaticMarkup(createElement(StorefrontProduct))).toContain("cd-pdp");
  });
});
