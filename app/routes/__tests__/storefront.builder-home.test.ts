// app/routes/__tests__/storefront.builder-home.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { toResponse } from "../../lib/__tests__/_route-test-helpers";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fixtureCatalog } from "~/lib/storefront/catalog.stub.server";
import StorefrontHome, { loader } from "../storefront._index";

// vi.hoisted refs are wired before module eval (vitest hoists vi.mock to top of file at
// transform time), so the import order above is safe — mocks are applied before execution.
const { getCatalogMock, loadPublishedMock, loaderDataRef } = vi.hoisted(() => ({
  getCatalogMock: vi.fn(),
  loadPublishedMock: vi.fn(),
  loaderDataRef: { current: null as unknown },
}));
vi.mock("~/lib/storefront/catalog.server", () => ({ getCatalog: getCatalogMock }));
vi.mock("~/lib/storebuilder/page-document.server", () => ({ loadPublishedDoc: loadPublishedMock }));
vi.mock("react-router", async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), useLoaderData: () => loaderDataRef.current }));

beforeEach(() => {
  getCatalogMock.mockReset().mockReturnValue(fixtureCatalog);
  loadPublishedMock.mockReset();
  loaderDataRef.current = null;
});
const req = () => new Request("https://demo.calderyncompany.com/storefront");

describe("storefront home on the block spine", () => {
  it("falls back to the default document when the shop has no published home doc", async () => {
    loadPublishedMock.mockResolvedValue(null);
    const data = await toResponse(await loader({ request: req(), params: {}, context: {} } as never)).json();
    expect(data.doc.blocks.map((b: { type: string }) => b.type)).toEqual(["hero", "productGrid"]);
    loaderDataRef.current = data;
    const html = renderToStaticMarkup(createElement(StorefrontHome));
    expect(html).toContain("cd-block--hero");
    expect(html).toContain("cd-store__grid"); // products rendered from the fixture
  });

  it("renders a published document when one exists", async () => {
    loadPublishedMock.mockResolvedValue({
      kind: "singleton", pageKey: "home",
      blocks: [{ id: "h", type: "hero", layout: { x: 0, y: 0, w: 12, h: 2 }, props: { headline: "CUSTOM STORE", subhead: "" } }],
    });
    const data = await toResponse(await loader({ request: req(), params: {}, context: {} } as never)).json();
    loaderDataRef.current = data;
    expect(renderToStaticMarkup(createElement(StorefrontHome))).toContain("CUSTOM STORE");
  });
});
