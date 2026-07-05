// Gateless publish + readiness read model for the Store studio.
// Publish must NEVER block: with no draft it seeds the default home doc and
// publishes that. loadStudioState exposes what's missing (products, checkout)
// so the UI can warn — warn, not gate.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { publishStudioStore, loadStudioState, saveStudioVibe } from "./studio.server";

// vi.mock is hoisted above the imports by vitest at transform time, so the
// mocks still apply even though they are written below them (imports-first
// satisfies the import/first rule).
const { fromMock, pageDoc, catalogMock, connectMock, adminListProducts, experimentsMock, settingsMock } =
  vi.hoisted(() => ({
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
    experimentsMock: { latestStudioExperiment: vi.fn(), hasRunningExperiment: vi.fn() },
    settingsMock: { getStoreSettings: vi.fn(), saveStoreSettings: vi.fn() },
  }));

vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => ({ from: fromMock }) }));
vi.mock("./page-document.server", () => pageDoc);
vi.mock("~/lib/storefront/catalog.server", () => ({ getCatalog: () => catalogMock }));
vi.mock("~/lib/payments/connect.server", () => connectMock);
vi.mock("~/lib/catalog/catalog.server", () => ({ listProducts: adminListProducts }));
vi.mock("~/lib/experiments/store-experiment.server", () => experimentsMock);
vi.mock("~/lib/storefront/settings.server", () => ({
  DEFAULT_PALETTE: { primary: "#0f766e", background: "#ffffff", text: "#111827" },
  getStoreSettings: settingsMock.getStoreSettings,
  saveStoreSettings: settingsMock.saveStoreSettings,
}));

const shop = "11111111-1111-1111-1111-111111111111";

// Per-table read results (maybeSingle) and a recorder for upsert payloads;
// tables without a configured result read as "no row".
const tableResults: Record<string, { data: unknown; error: unknown }> = {};
const upserts: Array<{ table: string; row: Record<string, unknown> }> = [];

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
  experimentsMock.latestStudioExperiment.mockResolvedValue(null);
  experimentsMock.hasRunningExperiment.mockResolvedValue(false);
  settingsMock.getStoreSettings.mockResolvedValue({
    storeName: "Test Store",
    palette: { primary: "#0f766e" },
    logoUrl: null,
    voiceTagline: null,
    vibe: "minimal",
  });
  settingsMock.saveStoreSettings.mockResolvedValue(undefined);
  for (const key of Object.keys(tableResults)) delete tableResults[key];
  upserts.length = 0;
  fromMock.mockImplementation((table: string) => {
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = () => chain;
    chain.order = () => chain;
    chain.limit = () => chain;
    chain.maybeSingle = () =>
      Promise.resolve(tableResults[table] ?? { data: null, error: null });
    chain.upsert = (row: Record<string, unknown>) => {
      upserts.push({ table, row });
      return Promise.resolve({ error: null });
    };
    return chain;
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
    expect(state.storefrontUrl).toBe("/storefront"); // load survived
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

describe("publishStudioStore PDP buy-path integrity", () => {
  it("injects the missing functional blocks from registry defaults before publishing a pdp draft", async () => {
    const pdpDraft = {
      kind: "template",
      pageKey: "pdp",
      blocks: [{ id: "g", type: "productGallery", layout: { x: 0, y: 0, w: 12, h: 4 }, props: {} }],
    };
    pageDoc.loadDraftDoc.mockImplementation(async (_shop: string, pageKey: string) =>
      pageKey === "pdp" ? pdpDraft : null,
    );
    await publishStudioStore(shop);
    const savedPdp = pageDoc.saveDraft.mock.calls.find((c) => c[1] === "pdp")?.[2] as {
      blocks: Array<{ type: string }>;
    };
    expect(savedPdp.blocks.map((b) => b.type)).toEqual(
      expect.arrayContaining(["productGallery", "price", "variantPicker", "addToCart"]),
    );
    expect(pageDoc.publishDoc).toHaveBeenCalledWith(shop, "pdp");
  });
});

describe("loadStudioState v2 fields", () => {
  it("defaults the vibe to minimal and reads the stored vibe from StoreSettings", async () => {
    let state = await loadStudioState(shop);
    expect(state.settings.vibe).toBe("minimal");
    settingsMock.getStoreSettings.mockResolvedValue({
      storeName: "Test Store",
      palette: { primary: "#0f766e" },
      logoUrl: null,
      voiceTagline: null,
      vibe: "bold",
    });
    state = await loadStudioState(shop);
    expect(state.settings.vibe).toBe("bold");
  });

  it("exposes orgSlug and the absolute tenant storefront URL when the shop has one", async () => {
    tableResults.shops = { data: { org_slug: "peak-pine-a1b2c3" }, error: null };
    const state = await loadStudioState(shop);
    expect(state.orgSlug).toBe("peak-pine-a1b2c3");
    expect(state.storefrontUrl).toBe("https://peak-pine-a1b2c3.calderyncompany.com/storefront");
  });

  it("keeps the app path for domain-keyed shops with no org_slug", async () => {
    const state = await loadStudioState(shop);
    expect(state.orgSlug).toBeNull();
    expect(state.storefrontUrl).toBe("/storefront");
  });

  it("embeds the latest experiment from the experiments lib", async () => {
    const exp = {
      id: "22222222-2222-2222-2222-222222222222",
      name: "Sharper headline",
      why: "Tests a product-led hero headline against your current copy on the home page.",
      pageKey: "home" as const,
      state: "running" as const,
      startedAt: "2026-07-05T00:00:00.000Z",
      decidedAt: null,
      report: null,
    };
    experimentsMock.latestStudioExperiment.mockResolvedValue(exp);
    const state = await loadStudioState(shop);
    expect(state.experiment).toEqual(exp);
    expect(experimentsMock.latestStudioExperiment).toHaveBeenCalledWith(shop);
  });
});

describe("saveStudioVibe", () => {
  it("saves the vibe through the StoreSettings contract, preserving the other brand fields", async () => {
    await saveStudioVibe(shop, "warm");
    expect(settingsMock.saveStoreSettings).toHaveBeenCalledWith(
      shop,
      expect.objectContaining({ storeName: "Test Store", vibe: "warm", logoUrl: null }),
    );
  });

  it("rejects non-uuid (demo/fixture) shops with a clean 422", async () => {
    await expect(saveStudioVibe("demo-shop", "bold")).rejects.toMatchObject({ status: 422 });
    expect(settingsMock.saveStoreSettings).not.toHaveBeenCalled();
  });
});

describe("publishStudioStore experiment guard", () => {
  it("409s instead of overwriting arm A while an experiment is running", async () => {
    experimentsMock.hasRunningExperiment.mockResolvedValue(true);
    await expect(publishStudioStore(shop)).rejects.toMatchObject({
      status: 409,
      code: "experiment_running",
    });
    expect(pageDoc.saveDraft).not.toHaveBeenCalled();
    expect(pageDoc.publishDoc).not.toHaveBeenCalled();
  });
});
