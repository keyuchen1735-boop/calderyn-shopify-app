// Gateless publish + readiness read model for the Store studio.
// Publish must NEVER block: with no draft it seeds the default home doc and
// publishes that. loadStudioState exposes what's missing (products, checkout)
// so the UI can warn — warn, not gate.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { publishStudioStore, loadStudioState, saveStudioVibe, sectionsFromDoc, moveStudioSection, removeStudioSection, regenerateStudioSection } from "./studio.server";

// vi.mock is hoisted above the imports by vitest at transform time, so the
// mocks still apply even though they are written below them (imports-first
// satisfies the import/first rule).
const { fromMock, pageDoc, catalogMock, connectMock, adminListProducts, experimentsMock, settingsMock, storegenMock } =
  vi.hoisted(() => ({
    storegenMock: { regenerateHomeSection: vi.fn() },
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
    connectMock: {
      getConnectedAccount: vi.fn(),
      // Real predicate shape: the studio panel must judge readiness by the same
      // three-flag definition the charge path routes on.
      isFullyEnabledAccount: (a: { charges_enabled?: boolean; payouts_enabled?: boolean; details_submitted?: boolean }) =>
        a.charges_enabled === true && a.payouts_enabled === true && a.details_submitted === true,
    },
    adminListProducts: vi.fn(),
    experimentsMock: {
      latestStudioExperiment: vi.fn(),
      hasRunningExperiment: vi.fn(),
      expireOverdueExperiment: vi.fn(async () => undefined),
    },
    settingsMock: { getStoreSettings: vi.fn(), saveStoreSettings: vi.fn() },
  }));

vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => ({ from: fromMock }) }));
vi.mock("./page-document.server", () => pageDoc);
vi.mock("~/lib/storefront/catalog.server", () => ({ getCatalog: () => catalogMock }));
vi.mock("~/lib/payments/connect.server", () => connectMock);
vi.mock("~/lib/catalog/catalog.server", () => ({ listProducts: adminListProducts }));
vi.mock("~/lib/experiments/store-experiment.server", () => experimentsMock);
vi.mock("~/lib/storegen/generate.server", () => storegenMock);
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

  it("exposes typeStyle and density from StoreSettings in the studio DTO", async () => {
    settingsMock.getStoreSettings.mockResolvedValue({
      storeName: "Test Store",
      palette: { primary: "#0f766e" },
      logoUrl: null,
      voiceTagline: null,
      vibe: "minimal",
      typeStyle: "editorial",
      density: "roomy",
    });
    const state = await loadStudioState(shop);
    expect(state.settings.typeStyle).toBe("editorial");
    expect(state.settings.density).toBe("roomy");
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

describe("studio sections", () => {
  const WRAP = '<div class="ai-store">';
  const STYLE = "<style>.ai-store .hero{color:#111}</style>";
  const HOME = {
    kind: "singleton",
    pageKey: "home",
    blocks: [
      { id: "s0", type: "rawHtml", layout: { x: 0, y: 0, w: 12, h: 8 }, props: { html: `${WRAP}${STYLE}<section class="hero"><h1>Big hero</h1></section></div>` } },
      { id: "g1", type: "productGrid", layout: { x: 0, y: 1, w: 12, h: 6 }, props: { heading: "Best sellers", source: { kind: "all" } } },
      { id: "s2", type: "rawHtml", layout: { x: 0, y: 2, w: 12, h: 8 }, props: { html: `${WRAP}${STYLE}<section class="closer"><h2>Come back soon</h2></section></div>` } },
    ],
  };

  it("sectionsFromDoc labels sections by heading and kind", () => {
    const sections = sectionsFromDoc(HOME as never);
    expect(sections).toEqual([
      { id: "s0", kind: "design", title: "Big hero" },
      { id: "g1", kind: "products", title: "Best sellers" },
      { id: "s2", kind: "design", title: "Come back soon" },
    ]);
  });

  it("moveStudioSection swaps neighbours, restacks y and saves the draft", async () => {
    pageDoc.loadDraftDoc.mockResolvedValue(HOME);
    const sections = await moveStudioSection(shop, "g1", "up");
    expect(sections.map((x) => x.id)).toEqual(["g1", "s0", "s2"]);
    const saved = pageDoc.saveDraft.mock.calls[0][2] as { blocks: { id: string; layout: { y: number } }[] };
    expect(saved.blocks.map((b) => b.layout.y)).toEqual([0, 1, 2]);
  });

  it("moveStudioSection at the edge is a no-op that saves nothing", async () => {
    pageDoc.loadDraftDoc.mockResolvedValue(HOME);
    const sections = await moveStudioSection(shop, "s0", "up");
    expect(sections.map((x) => x.id)).toEqual(["s0", "g1", "s2"]);
    expect(pageDoc.saveDraft).not.toHaveBeenCalled();
  });

  it("removeStudioSection deletes the block but refuses to empty the page", async () => {
    pageDoc.loadDraftDoc.mockResolvedValue(HOME);
    const sections = await removeStudioSection(shop, "g1");
    expect(sections.map((x) => x.id)).toEqual(["s0", "s2"]);

    pageDoc.loadDraftDoc.mockResolvedValue({ ...HOME, blocks: [HOME.blocks[0]] });
    await expect(removeStudioSection(shop, "s0")).rejects.toMatchObject({ status: 422, code: "last_section" });
  });

  it("section mutations refuse mid-test (arm A must not change under a running experiment)", async () => {
    experimentsMock.hasRunningExperiment.mockResolvedValue(true);
    pageDoc.loadDraftDoc.mockResolvedValue(HOME);
    await expect(moveStudioSection(shop, "g1", "up")).rejects.toMatchObject({ status: 409, code: "experiment_running" });
    await expect(removeStudioSection(shop, "g1")).rejects.toMatchObject({ status: 409 });
    await expect(regenerateStudioSection(shop, "s0")).rejects.toMatchObject({ status: 409 });
  });

  it("regenerateStudioSection peels the wrapper and style, then re-wraps the replacement with the SAME style", async () => {
    pageDoc.loadDraftDoc.mockResolvedValue(HOME);
    storegenMock.regenerateHomeSection.mockResolvedValue('<section class="hero"><h1>Fresh hero</h1></section>');
    await regenerateStudioSection(shop, "s0", "punchier");
    expect(storegenMock.regenerateHomeSection).toHaveBeenCalledWith(shop, '<section class="hero"><h1>Big hero</h1></section>', "punchier");
    const saved = pageDoc.saveDraft.mock.calls[0][2] as { blocks: { id: string; props: { html?: string } }[] };
    const block = saved.blocks.find((b) => b.id === "s0")!;
    expect(block.props.html).toBe(`${WRAP}${STYLE}<section class="hero"><h1>Fresh hero</h1></section></div>`);
  });

  it("labels template-vocabulary blocks as content (movable, never a dead Redo)", () => {
    const doc = {
      kind: "singleton",
      pageKey: "home",
      blocks: [
        { id: "h", type: "hero", layout: { x: 0, y: 0, w: 12, h: 2 }, props: { headline: "Welcome in", subhead: "" } },
        { id: "f", type: "featureRow", layout: { x: 0, y: 2, w: 12, h: 2 }, props: { heading: "Why us", items: [] } },
      ],
    };
    expect(sectionsFromDoc(doc as never)).toEqual([
      { id: "h", kind: "content", title: "Welcome in" },
      { id: "f", kind: "content", title: "Why us" },
    ]);
  });

  it("regenerating a legacy multi-section block splits it apart and asks again instead of eating the page", async () => {
    const legacy = {
      ...HOME,
      blocks: [
        { id: "home-html", type: "rawHtml", layout: { x: 0, y: 0, w: 12, h: 12 }, props: { html: `${WRAP}${STYLE}<section id="a">A</section><section id="b">B</section></div>` } },
      ],
    };
    pageDoc.loadDraftDoc.mockResolvedValue(legacy);
    await expect(regenerateStudioSection(shop, "home-html")).rejects.toMatchObject({ status: 409, code: "sections_split" });
    // The split itself was persisted: two blocks now, each wrapped with the shared style.
    expect(storegenMock.regenerateHomeSection).not.toHaveBeenCalled();
    const saved = pageDoc.saveDraft.mock.calls[0][2] as { blocks: { id: string; props: { html?: string } }[] };
    expect(saved.blocks).toHaveLength(2);
    expect(saved.blocks[0].props.html).toContain('id="a"');
    expect(saved.blocks[1].props.html).toContain('id="b"');
    expect(saved.blocks[1].props.html).toContain("<style>");
  });

  it("refuses to apply a regeneration onto a draft that changed during the model call", async () => {
    const changed = {
      ...HOME,
      blocks: HOME.blocks.map((b) => (b.id === "s0" ? { ...b, props: { html: `${WRAP}${STYLE}<section class="hero"><h1>Rebuilt meanwhile</h1></section></div>` } } : b)),
    };
    // First read returns the original doc; the re-read after the model call sees a rebuilt draft.
    pageDoc.loadDraftDoc.mockResolvedValueOnce(HOME).mockResolvedValueOnce(changed);
    storegenMock.regenerateHomeSection.mockResolvedValue('<section class="hero"><h1>Fresh</h1></section>');
    await expect(regenerateStudioSection(shop, "s0")).rejects.toMatchObject({ status: 409, code: "section_changed" });
    expect(pageDoc.saveDraft).not.toHaveBeenCalled();
  });

  it("regenerateStudioSection refuses catalog sections and surfaces engine failure", async () => {
    pageDoc.loadDraftDoc.mockResolvedValue(HOME);
    await expect(regenerateStudioSection(shop, "g1")).rejects.toMatchObject({ status: 422, code: "not_a_design_section" });
    storegenMock.regenerateHomeSection.mockResolvedValue(null);
    await expect(regenerateStudioSection(shop, "s0")).rejects.toMatchObject({ status: 502, code: "section_regen_failed" });
  });
});
