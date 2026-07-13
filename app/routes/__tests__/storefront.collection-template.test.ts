// app/routes/__tests__/storefront.collection-template.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fixtureCatalog } from "~/lib/storefront/catalog.stub.server";
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

describe("collection route on the block spine", () => {
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

  it("falls back to the legacy grid when there is no template doc", async () => {
    loadPublishedMock.mockResolvedValue(null);
    const data = requireLegacyLoaderData(await (await loader(args("apparel"))).json());
    expect(data.doc).toBeNull();
    loaderDataRef.current = data;
    expect(renderToStaticMarkup(createElement(StorefrontCollection))).toContain("cd-store__grid");
  });
});
