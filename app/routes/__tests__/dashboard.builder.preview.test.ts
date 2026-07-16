// app/routes/__tests__/dashboard.builder.preview.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fixtureCatalog } from "~/lib/storefront/catalog.stub.server";
import BuilderPreview, { loader, action } from "../dashboard.builder.preview";

const { sessionMock, getCatalogMock, loadDraftMock, loaderDataRef, enhanceMock, applyAssetOverridesMock } = vi.hoisted(() => ({
  sessionMock: vi.fn(), getCatalogMock: vi.fn(), loadDraftMock: vi.fn(), loaderDataRef: { current: null as unknown }, enhanceMock: vi.fn(), applyAssetOverridesMock: vi.fn(),
}));
// The route imports the storefront stylesheet as a URL; stub it like the other preview test.
vi.mock("~/styles/storefront.css?url", () => ({ default: "/assets/storefront.css" }));
vi.mock("~/lib/dashboard/session.server", () => ({ requireVerifiedSession: sessionMock }));
vi.mock("~/lib/dashboard/http.server", () => ({ requireSameOrigin: () => {} }));
vi.mock("~/lib/storefront/catalog.server", () => ({ getCatalog: getCatalogMock }));
vi.mock("~/lib/storebuilder/page-document.server", () => ({ loadDraftDoc: loadDraftMock }));
vi.mock("@remix-run/react", () => ({ useLoaderData: () => loaderDataRef.current, Form: (p: Record<string, unknown>) => createElement("form", p) }));
vi.mock("~/lib/storegen/imagery/detector", () => ({ findImprovableListings: () => [{ productId: "1", handle: "h-1", title: "P1", reason: "No image", severity: 2 }] }));
vi.mock("~/lib/storegen/imagery/asset.server", () => ({ enhanceListing: enhanceMock, applyAssetOverrides: applyAssetOverridesMock }));

const realShop = "11111111-1111-1111-1111-111111111111";
beforeEach(() => {
  sessionMock.mockReset().mockResolvedValue({ shopId: realShop });
  getCatalogMock.mockReset().mockReturnValue(fixtureCatalog);
  applyAssetOverridesMock.mockReset().mockImplementation(async (_shopId: string, products: unknown[]) => products);
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
  it("renders the PDP pane through the shared column layout (same composition as the live PDP)", async () => {
    loadDraftMock.mockImplementation(async (_s: string, page: string) =>
      page === "pdp"
        ? { kind: "template", pageKey: "pdp", blocks: [
            { id: "g", type: "productGallery", layout: { x: 0, y: 0, w: 6, h: 6 }, props: { maxImages: 6 } },
            { id: "t", type: "productTitle", layout: { x: 6, y: 0, w: 6, h: 1 }, props: {} },
          ] }
        : null);
    const data = await (await loader(req())).json();
    loaderDataRef.current = data;
    const html = renderToStaticMarkup(createElement(BuilderPreview));
    expect(html).toContain("cd-pdp cd-pdp--blocks"); // not a flat stack
    expect(html.match(/class="cd-pdp__col"/g)).toHaveLength(2); // gallery left, title right
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

  it("uses getCatalog's asset wrapper without applying a second override", async () => {
    loadDraftMock.mockResolvedValue(null);
    await loader(req());
    expect(applyAssetOverridesMock).not.toHaveBeenCalled();
  });

  it("loader surfaces enhanceError when the redirect param is set", async () => {
    loadDraftMock.mockResolvedValue(null);
    const r = { request: new Request("https://app/dashboard/builder/preview?enhanceError=1"), params: {}, context: {} } as never;
    const data = await (await loader(r)).json();
    expect(data.enhanceError).toBe(true);
    loaderDataRef.current = data;
    expect(renderToStaticMarkup(createElement(BuilderPreview))).toContain("Image generation failed");
  });

  it("action enhances a selected listing", async () => {
    // "p-tee" is the first product in fixtureCatalog; plan used "1" but fixture IDs are prefixed.
    enhanceMock.mockResolvedValue({ productId: "p-tee", status: "ready", url: "https://img/n.png" });
    const post = (id: string) => action({ request: new Request("https://app/dashboard/builder/preview", { method: "POST", body: new URLSearchParams({ productId: id }) }), params: {}, context: {} } as never);
    const res = await post("p-tee");
    expect(enhanceMock).toHaveBeenCalled();
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/builder/preview");
  });

  it("action rejects with 400 when productId is missing", async () => {
    const res: Response = await action({ request: new Request("https://app/dashboard/builder/preview", { method: "POST", body: new URLSearchParams({}) }), params: {}, context: {} } as never).then(
      () => { throw new Error("expected a thrown Response"); },
      (e) => e,
    );
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(400);
  });

  it("action rejects with 404 when the product is not in the catalog", async () => {
    const res: Response = await action({ request: new Request("https://app/dashboard/builder/preview", { method: "POST", body: new URLSearchParams({ productId: "does-not-exist" }) }), params: {}, context: {} } as never).then(
      () => { throw new Error("expected a thrown Response"); },
      (e) => e,
    );
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(404);
  });

  it("action redirects with enhanceError=1 when enhancement fails (rule 12)", async () => {
    enhanceMock.mockResolvedValue({ productId: "p-tee", status: "failed", url: null });
    const res = await action({ request: new Request("https://app/dashboard/builder/preview", { method: "POST", body: new URLSearchParams({ productId: "p-tee" }) }), params: {}, context: {} } as never);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("enhanceError=1");
  });
});
