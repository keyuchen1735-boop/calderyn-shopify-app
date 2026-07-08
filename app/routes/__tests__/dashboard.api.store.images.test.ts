import { describe, it, expect, vi, beforeEach } from "vitest";

const enhanceMock = vi.hoisted(() => vi.fn());
const providerMock = vi.hoisted(() => vi.fn());
const persistMock = vi.hoisted(() => vi.fn());
const loadDraftMock = vi.hoisted(() => vi.fn());
const saveDraftMock = vi.hoisted(() => vi.fn());
const listProductsMock = vi.hoisted(() => vi.fn());
const listCollectionsMock = vi.hoisted(() => vi.fn());
const assetRowsMock = vi.hoisted(() => vi.fn());

vi.mock("~/lib/dashboard/session.server", () => ({ requireDashboardSession: async () => ({ shopId: "3f0e8f5e-0000-4000-8000-000000000000" }) }));
vi.mock("~/lib/dashboard/http.server", () => ({ requireSameOrigin: () => {}, jsonError: (s: number, c: string) => new Response(JSON.stringify({ error: c }), { status: s }) }));
vi.mock("~/lib/storegen/imagery/asset.server", () => ({ enhanceListing: enhanceMock }));
vi.mock("~/lib/storegen/imagery/provider.server", () => ({ getImageProvider: () => ({ name: "test", generateListingImage: providerMock }) }));
vi.mock("~/lib/assets/persist.server", () => ({ persistExternalImage: persistMock }));
vi.mock("~/lib/storebuilder/page-document.server", () => ({ loadDraftDoc: loadDraftMock, saveDraft: saveDraftMock }));
vi.mock("~/lib/storefront/catalog.server", () => ({ getCatalog: () => ({ listProducts: listProductsMock, listCollections: listCollectionsMock, getProduct: vi.fn() }) }));
vi.mock("~/lib/storefront/settings.server", () => ({ getStoreSettings: async () => ({ storeName: "Acme", voiceTagline: "Go far", palette: { primary: "#111", background: "#fff", text: "#000" }, vibe: "minimal", logoUrl: null }) }));
vi.mock("~/lib/storebuilder/sanitize-html.server", () => ({ sanitizeStoreHtml: (h: string) => h }));
vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => ({ from: () => ({ select: () => ({ eq: assetRowsMock }) }) }) }));

// eslint-disable-next-line import/first -- vitest hoists the vi.mock calls above this import
import { action } from "../dashboard.api.store.images";

const product = (id: string, tags: string[] = ["calderyn:sample"]) => ({
  id, handle: `h-${id}`, title: `P ${id}`, description: "d", images: [], variants: [], collections: [], tags,
});
const req = () => new Request("http://x/dashboard/api/store/images", { method: "POST" });

beforeEach(() => {
  for (const m of [enhanceMock, providerMock, persistMock, loadDraftMock, saveDraftMock, listProductsMock, listCollectionsMock, assetRowsMock]) m.mockReset();
  listCollectionsMock.mockResolvedValue([]);
  assetRowsMock.mockResolvedValue({ data: [], error: null });
  loadDraftMock.mockResolvedValue(null);
  enhanceMock.mockResolvedValue({ productId: "a", status: "ready", url: "https://img/x" });
});

describe("image fill action", () => {
  it("hero first: patches the data-cd-hero-media marker and saves the draft", async () => {
    loadDraftMock.mockResolvedValue({ kind: "singleton", pageKey: "home", blocks: [{ id: "b1", type: "rawHtml", props: { html: '<section class="hero"><div data-cd-hero-media></div><h1>Hi</h1></section>' }, layout: {} }] });
    providerMock.mockResolvedValue({ url: "https://ephemeral/hero" });
    persistMock.mockResolvedValue({ url: "https://owned/hero.jpg" });
    listProductsMock.mockResolvedValue([product("a")]);
    const res = await action({ request: req(), params: {}, context: {} } as never);
    const body = await (res as Response).json();
    expect(providerMock).toHaveBeenCalledWith(expect.objectContaining({ mode: "lifestyle_scene" }));
    expect(saveDraftMock).toHaveBeenCalled();
    const savedHtml = saveDraftMock.mock.calls[0][2].blocks[0].props.html;
    expect(savedHtml).toContain('src="https://owned/hero.jpg"');
    expect(savedHtml).not.toContain("<div data-cd-hero-media>");
    expect(body).toMatchObject({ done: false, kind: "hero" });
    expect(enhanceMock).not.toHaveBeenCalled();
  });
  it("then one pending product per call, reporting remaining", async () => {
    listProductsMock.mockResolvedValue([product("a"), product("b")]);
    const res = await action({ request: req(), params: {}, context: {} } as never);
    const body = await (res as Response).json();
    expect(enhanceMock).toHaveBeenCalledTimes(1);
    expect(body).toMatchObject({ done: false, kind: "product", remaining: 1 });
  });
  it("skips products with an existing store_asset row (ready OR failed — no retry loop)", async () => {
    listProductsMock.mockResolvedValue([product("a")]);
    assetRowsMock.mockResolvedValue({ data: [{ product_id: "a", status: "failed" }], error: null });
    const res = await action({ request: req(), params: {}, context: {} } as never);
    expect(enhanceMock).not.toHaveBeenCalled();
    expect(await (res as Response).json()).toMatchObject({ done: true, remaining: 0 });
  });
  it("hero failure with a pending product still advances the loop with one product", async () => {
    loadDraftMock.mockResolvedValue({ kind: "singleton", pageKey: "home", blocks: [{ id: "b1", type: "rawHtml", props: { html: "<div data-cd-hero-media></div>" }, layout: {} }] });
    providerMock.mockRejectedValue(new Error("credits"));
    listProductsMock.mockResolvedValue([product("a")]);
    const body = await (await action({ request: req(), params: {}, context: {} } as never) as Response).json();
    expect(enhanceMock).toHaveBeenCalledTimes(1);
    expect(body).toMatchObject({ done: true, kind: "product", heroFailed: true, remaining: 0 });
    // The failed hero neutralizes its marker and saves once, so it is not re-attempted next loop.
    expect(saveDraftMock).toHaveBeenCalledTimes(1);
    const savedHtml = saveDraftMock.mock.calls[0][2].blocks[0].props.html;
    expect(savedHtml).not.toContain("data-cd-hero-media");
    expect(savedHtml).not.toContain("<img");
  });
  it("hero generation failure is non-fatal: reports heroFailed and moves on (rule 12)", async () => {
    loadDraftMock.mockResolvedValue({ kind: "singleton", pageKey: "home", blocks: [{ id: "b1", type: "rawHtml", props: { html: "<div data-cd-hero-media></div>" }, layout: {} }] });
    providerMock.mockRejectedValue(new Error("credits"));
    listProductsMock.mockResolvedValue([]);
    const body = await (await action({ request: req(), params: {}, context: {} } as never) as Response).json();
    expect(saveDraftMock).toHaveBeenCalledTimes(1);
    const savedHtml = saveDraftMock.mock.calls[0][2].blocks[0].props.html;
    expect(savedHtml).not.toContain("data-cd-hero-media");
    expect(savedHtml).not.toContain("<img");
    expect(body).toMatchObject({ done: true, heroFailed: true });
  });
});
