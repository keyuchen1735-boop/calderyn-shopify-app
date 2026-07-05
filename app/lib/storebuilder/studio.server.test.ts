// Gateless publish + readiness read model for the Store studio.
// Publish must NEVER block: with no draft it seeds the default home doc and
// publishes that. loadStudioState exposes what's missing (products, checkout)
// so the UI can warn — warn, not gate.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { publishStudioStore, loadStudioState } from "./studio.server";

// vi.mock is hoisted above the imports by vitest at transform time, so the
// mocks still apply even though they are written below them (imports-first
// satisfies the import/first rule).
const { fromMock, pageDoc, catalogMock, connectMock, adminListProducts } = vi.hoisted(() => ({
  fromMock: vi.fn(),
  pageDoc: {
    loadDraftDoc: vi.fn(),
    loadPublishedDoc: vi.fn(),
    saveDraft: vi.fn(),
    publishDoc: vi.fn(),
  },
  catalogMock: {
    listProducts: vi.fn(),
    listCollections: vi.fn(),
  },
  connectMock: { getConnectedAccount: vi.fn() },
  adminListProducts: vi.fn(),
}));

vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => ({ from: fromMock }) }));
vi.mock("./page-document.server", () => pageDoc);
vi.mock("~/lib/storefront/catalog.server", () => ({ getCatalog: () => catalogMock }));
vi.mock("~/lib/payments/connect.server", () => connectMock);
vi.mock("~/lib/catalog/catalog.server", () => ({ listProducts: adminListProducts }));
vi.mock("~/lib/storefront/settings.server", () => ({
  DEFAULT_PALETTE: { primary: "#0f766e", background: "#ffffff", text: "#111827" },
  getStoreSettings: vi.fn().mockResolvedValue({
    storeName: "Test Store",
    palette: { primary: "#0f766e" },
    logoUrl: null,
    voiceTagline: null,
  }),
  saveStoreSettings: vi.fn(),
}));

const shop = "11111111-1111-1111-1111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
  catalogMock.listProducts.mockResolvedValue([]);
  catalogMock.listCollections.mockResolvedValue([]);
  connectMock.getConnectedAccount.mockResolvedValue(null);
  adminListProducts.mockResolvedValue({ products: [], total: 0 });
  pageDoc.loadDraftDoc.mockResolvedValue(null);
  pageDoc.loadPublishedDoc.mockResolvedValue(null);
  pageDoc.saveDraft.mockResolvedValue(undefined);
  pageDoc.publishDoc.mockResolvedValue(undefined);
  // latestGeneration query (select→eq→order→limit→maybeSingle) and the
  // shopOrgSlug lookup (select→eq→maybeSingle) — no rows for either.
  const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
  fromMock.mockReturnValue({
    select: () => ({ eq: () => ({ order: () => ({ limit: () => ({ maybeSingle }) }), maybeSingle }) }),
  });
});

describe("publishStudioStore (gateless)", () => {
  it("publishes the default home doc when no draft exists instead of throwing", async () => {
    await expect(publishStudioStore(shop)).resolves.toBeUndefined();
    // The seeded draft is the default home document (has a hero block).
    expect(pageDoc.saveDraft).toHaveBeenCalledWith(
      shop,
      "home",
      expect.objectContaining({
        blocks: expect.arrayContaining([expect.objectContaining({ type: "hero" })]),
      }),
    );
    expect(pageDoc.publishDoc).toHaveBeenCalledWith(shop, "home");
  });

  it("still publishes real drafts without seeding the default doc", async () => {
    const draft = {
      kind: "singleton",
      pageKey: "home",
      blocks: [{ id: "h", type: "hero", layout: { x: 0, y: 0, w: 12, h: 2 }, props: { headline: "Hi", subhead: "" } }],
    };
    pageDoc.loadDraftDoc.mockImplementation(async (_shop: string, pageKey: string) =>
      pageKey === "home" ? draft : null,
    );
    await publishStudioStore(shop);
    expect(pageDoc.publishDoc).toHaveBeenCalledTimes(1);
    expect(pageDoc.saveDraft).toHaveBeenCalledWith(
      shop,
      "home",
      expect.objectContaining({ blocks: [expect.objectContaining({ type: "hero" })] }),
    );
  });
});

describe("loadStudioState readiness", () => {
  it("reports zero products and checkout not ready for a fresh shop", async () => {
    const state = await loadStudioState(shop);
    expect(state.productCount).toBe(0);
    expect(state.checkoutReady).toBe(false);
  });

  it("reports the full catalog count and checkout ready for a fully-enabled account", async () => {
    catalogMock.listProducts.mockResolvedValue(
      Array.from({ length: 5 }, (_, i) => ({
        id: `p${i}`,
        title: `P${i}`,
        variants: [],
        images: [],
      })),
    );
    connectMock.getConnectedAccount.mockResolvedValue({
      charges_enabled: true,
      payouts_enabled: true,
      details_submitted: true,
    });
    const state = await loadStudioState(shop);
    expect(state.productCount).toBe(5); // full count, not the 3-product preview slice
    expect(state.products).toHaveLength(3);
    expect(state.checkoutReady).toBe(true);
  });

  it("treats a half-onboarded account (charges only) as not ready, matching the Payments screen", async () => {
    connectMock.getConnectedAccount.mockResolvedValue({
      charges_enabled: true,
      payouts_enabled: false,
      details_submitted: false,
    });
    const state = await loadStudioState(shop);
    expect(state.checkoutReady).toBe(false);
  });

  it("reports not-ready instead of failing the whole studio load when the payments read errors", async () => {
    connectMock.getConnectedAccount.mockRejectedValue(new Error("db blip"));
    const state = await loadStudioState(shop);
    expect(state.checkoutReady).toBe(false);
    expect(state.storefrontPath).toBe("/storefront"); // load survived
  });

  it("counts draft products separately so the UI can say where attachments went", async () => {
    adminListProducts.mockResolvedValue({ products: [], total: 4 });
    const state = await loadStudioState(shop);
    expect(state.draftProductCount).toBe(4);
    expect(adminListProducts).toHaveBeenCalledWith(shop, expect.objectContaining({ status: "draft" }));
  });
});

describe("publishStudioStore demo guard", () => {
  it("rejects non-uuid (demo/fixture) shops with a clean 422 instead of a raw 500", async () => {
    await expect(publishStudioStore("demo-shop")).rejects.toMatchObject({ status: 422 });
    expect(pageDoc.saveDraft).not.toHaveBeenCalled();
  });
});
