// app/routes/__tests__/dashboard.builder.preview.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fixtureCatalog } from "~/lib/storefront/catalog.stub.server";
import BuilderPreview, { loader } from "../dashboard.builder.preview";

const { sessionMock, getCatalogMock, loadDraftMock, loaderDataRef, enhanceMock } = vi.hoisted(() => ({
  sessionMock: vi.fn(), getCatalogMock: vi.fn(), loadDraftMock: vi.fn(), loaderDataRef: { current: null as unknown }, enhanceMock: vi.fn(),
}));
vi.mock("~/lib/dashboard/session.server", () => ({ getSessionOrRedirect: sessionMock }));
vi.mock("~/lib/storefront/catalog.server", () => ({ getCatalog: getCatalogMock }));
vi.mock("~/lib/storebuilder/page-document.server", () => ({ loadDraftDoc: loadDraftMock }));
vi.mock("@remix-run/react", () => ({ useLoaderData: () => loaderDataRef.current, Form: (p: Record<string, unknown>) => createElement("form", p) }));
vi.mock("~/lib/storegen/imagery/detector", () => ({ findImprovableListings: () => [{ productId: "1", handle: "h-1", title: "P1", reason: "No image", severity: 2 }] }));
vi.mock("~/lib/storegen/imagery/asset.server", () => ({ enhanceListing: enhanceMock, applyAssetOverrides: async (_s: string, ps: unknown[]) => ps }));

const realShop = "11111111-1111-1111-1111-111111111111";
beforeEach(() => {
  sessionMock.mockReset().mockResolvedValue({ shopId: realShop });
  getCatalogMock.mockReset().mockReturnValue(fixtureCatalog);
  loadDraftMock.mockReset();
  loaderDataRef.current = null;
});
const req = () => ({ request: new Request("https://app/dashboard/builder/preview"), params: {}, context: {} } as never);

describe("builder draft preview", () => {
  it("renders the home draft when present", async () => {
    loadDraftMock.mockImplementation(async (_s: string, page: string) =>
      page === "home" ? { kind: "singleton", pageKey: "home", blocks: [{ id: "h", type: "hero", layout: { x: 0, y: 0, w: 12, h: 2 }, props: { headline: "DRAFTED", subhead: "" } }] } : null);
    const data = await (await loader(req())).json();
    loaderDataRef.current = data;
    expect(renderToStaticMarkup(createElement(BuilderPreview))).toContain("DRAFTED");
  });
  it("shows an empty-state when there is no draft yet", async () => {
    loadDraftMock.mockResolvedValue(null);
    const data = await (await loader(req())).json();
    loaderDataRef.current = data;
    expect(renderToStaticMarkup(createElement(BuilderPreview))).toContain("No draft");
  });

  it("loader lists improvable-listing candidates", async () => {
    loadDraftMock.mockResolvedValue(null);
    const data = await (await loader(req())).json();
    expect(data.candidates[0].productId).toBe("1");
    loaderDataRef.current = data;
    expect(renderToStaticMarkup(createElement(BuilderPreview))).toContain("No image");
  });

  it("action enhances a selected listing", async () => {
    // "p-tee" is the first product in fixtureCatalog; plan used "1" but fixture IDs are prefixed.
    enhanceMock.mockResolvedValue({ productId: "p-tee", status: "ready", url: "https://img/n.png" });
    const { action } = await import("../dashboard.builder.preview");
    const res = await action({ request: new Request("https://app/dashboard/builder/preview", { method: "POST", body: new URLSearchParams({ productId: "p-tee" }) }), params: {}, context: {} } as never);
    expect(enhanceMock).toHaveBeenCalled();
    expect(res.status).toBe(302);
  });
});
