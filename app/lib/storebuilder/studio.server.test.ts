import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadStudioState, requirePublishableTenantDomain, sectionsFromDoc } from "./studio.server";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  listProducts: vi.fn(),
  listCollections: vi.fn(),
  loadDraft: vi.fn(),
  loadPublished: vi.fn(),
  getSettings: vi.fn(),
  getConnectedAccount: vi.fn(),
  adminListProducts: vi.fn(),
  latestExperiment: vi.fn(),
  readReleaseState: vi.fn(),
  loadPolicies: vi.fn(),
}));

vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => ({ from: mocks.from }) }));
vi.mock("~/lib/storefront/catalog.server", () => ({
  getCatalog: () => ({ listProducts: mocks.listProducts, listCollections: mocks.listCollections }),
}));
vi.mock("./page-document.server", () => ({
  loadDraftDoc: mocks.loadDraft,
  loadPublishedDoc: mocks.loadPublished,
}));
vi.mock("~/lib/storefront/settings.server", () => ({
  DEFAULT_PALETTE: { primary: "#0f766e", background: "#ffffff", text: "#111827" },
  getStoreSettings: mocks.getSettings,
}));
vi.mock("~/lib/payments/connect.server", () => ({
  getConnectedAccount: mocks.getConnectedAccount,
  isFullyEnabledAccount: (account: {
    charges_enabled?: boolean;
    payouts_enabled?: boolean;
    details_submitted?: boolean;
  }) => account.charges_enabled === true && account.payouts_enabled === true && account.details_submitted === true,
}));
vi.mock("~/lib/catalog/catalog.server", () => ({ listProducts: mocks.adminListProducts }));
vi.mock("~/lib/experiments/store-experiment.server", () => ({ latestStudioExperiment: mocks.latestExperiment }));
vi.mock("~/lib/storefront-bundle/build.server", () => ({ readStorefrontReleaseState: mocks.readReleaseState }));
vi.mock("~/lib/storefront/policies.server", () => ({ loadStorefrontPolicies: mocks.loadPolicies }));
vi.mock("~/lib/storefront/vercel-domain.server", () => ({
  isTenantDomainReachable: vi.fn(),
  registerTenantDomain: vi.fn(),
  tenantDomain: (slug: string) => `${slug}.example.test`,
}));
vi.mock("~/lib/auth/tenant.server", () => ({ slugify: vi.fn() }));

const shop = "11111111-1111-1111-1111-111111111111";
const tableResults: Record<string, { data: unknown; error: unknown }> = {};

beforeEach(() => {
  vi.clearAllMocks();
  for (const table of Object.keys(tableResults)) delete tableResults[table];
  mocks.from.mockImplementation((table: string) => {
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = () => chain;
    chain.order = () => chain;
    chain.limit = () => chain;
    chain.maybeSingle = () => Promise.resolve(tableResults[table] ?? { data: null, error: null });
    return chain;
  });
  mocks.listProducts.mockResolvedValue([]);
  mocks.listCollections.mockResolvedValue([]);
  mocks.loadDraft.mockResolvedValue(null);
  mocks.loadPublished.mockResolvedValue(null);
  mocks.getSettings.mockResolvedValue({
    storeName: "Test Store",
    palette: { primary: "#123456" },
    logoUrl: null,
    voiceTagline: null,
    vibe: "minimal",
    typeStyle: "classic",
    density: "standard",
  });
  mocks.getConnectedAccount.mockResolvedValue(null);
  mocks.adminListProducts.mockResolvedValue({ products: [], total: 0 });
  mocks.latestExperiment.mockResolvedValue(null);
  mocks.readReleaseState.mockResolvedValue({
    draftVersionId: null,
    publishedVersionId: null,
    draftRuntimeVersion: null,
    publishedRuntimeVersion: null,
  });
  mocks.loadPolicies.mockResolvedValue([]);
});

afterEach(() => vi.unstubAllEnvs());

describe("store snapshot", () => {
  it("loads the demo snapshot without invoking UUID-only read models", async () => {
    await expect(loadStudioState("demo-shop")).resolves.toMatchObject({
      productCount: 0,
      draftProductCount: 0,
      checkoutReady: false,
      hasDraft: false,
      hasPublished: false,
      release: { draftVersionId: null, publishedVersionId: null, draftRuntime: 0, publishedRuntime: 0 },
      storefrontUrl: "/storefront",
      policies: [],
    });
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("preserves every merchant setting field in the read-only DTO", async () => {
    mocks.getSettings.mockResolvedValue({
      storeName: "Peak Pine",
      palette: { primary: "#765432" },
      logoUrl: "https://cdn.example/logo.png",
      voiceTagline: "Made outside",
      vibe: "warm",
      typeStyle: "editorial",
      density: "roomy",
    });
    await expect(loadStudioState(shop)).resolves.toMatchObject({
      settings: {
        storeName: "Peak Pine",
        accent: "#765432",
        logoUrl: "https://cdn.example/logo.png",
        tagline: "Made outside",
        vibe: "warm",
        typeStyle: "editorial",
        density: "roomy",
      },
    });
  });

  it("reports the full product count while limiting preview products to three", async () => {
    mocks.listProducts.mockResolvedValue(Array.from({ length: 5 }, (_, index) => ({
      id: `p${index}`,
      title: `Product ${index}`,
      variants: [],
      images: [],
    })));
    const state = await loadStudioState(shop);
    expect(state.productCount).toBe(5);
    expect(state.products).toHaveLength(3);
  });

  it("uses the checkout charge path's complete three-flag readiness predicate", async () => {
    mocks.getConnectedAccount.mockResolvedValue({
      charges_enabled: true,
      payouts_enabled: true,
      details_submitted: true,
    });
    await expect(loadStudioState(shop)).resolves.toMatchObject({ checkoutReady: true });

    mocks.getConnectedAccount.mockResolvedValue({
      charges_enabled: true,
      payouts_enabled: false,
      details_submitted: true,
    });
    await expect(loadStudioState(shop)).resolves.toMatchObject({ checkoutReady: false });
  });

  it("falls back to not ready without failing the snapshot when payments cannot be read", async () => {
    mocks.getConnectedAccount.mockRejectedValue(new Error("payments unavailable"));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(loadStudioState(shop)).resolves.toMatchObject({
      checkoutReady: false,
      storefrontUrl: "/storefront",
    });
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("counts draft products separately from the live catalog", async () => {
    mocks.adminListProducts.mockResolvedValue({ products: [], total: 4 });
    await expect(loadStudioState(shop)).resolves.toMatchObject({ draftProductCount: 4 });
    expect(mocks.adminListProducts).toHaveBeenCalledWith(shop, { status: "draft", limit: 1 });
  });

  it("exposes immutable release pointers and their runtime versions", async () => {
    mocks.readReleaseState.mockResolvedValue({
      draftVersionId: "33333333-3333-3333-3333-333333333333",
      publishedVersionId: "44444444-4444-4444-4444-444444444444",
      draftRuntimeVersion: 1,
      publishedRuntimeVersion: 1,
    });
    await expect(loadStudioState(shop)).resolves.toMatchObject({
      hasDraft: true,
      hasPublished: true,
      release: {
        draftVersionId: "33333333-3333-3333-3333-333333333333",
        publishedVersionId: "44444444-4444-4444-4444-444444444444",
        draftRuntime: 1,
        publishedRuntime: 1,
      },
    });
  });

  it("returns only persisted merchant policies", async () => {
    const policies = [{
      id: "terms",
      title: "Purchase terms",
      body: "Payment is due at checkout.",
      updatedAt: "2026-07-14T12:00:00.000Z",
    }];
    mocks.loadPolicies.mockResolvedValue(policies);
    await expect(loadStudioState(shop)).resolves.toMatchObject({ policies });
    expect(mocks.loadPolicies).toHaveBeenCalledWith(shop);
  });

  it("builds the public tenant URL from the shop's owned slug", async () => {
    tableResults.shops = { data: { org_slug: "peak-pine-a1b2c3" }, error: null };
    await expect(loadStudioState(shop)).resolves.toMatchObject({
      orgSlug: "peak-pine-a1b2c3",
      storefrontUrl: "https://peak-pine-a1b2c3.example.test/storefront",
    });
  });

  it("shapes legacy page sections as read-only preview metadata", () => {
    expect(sectionsFromDoc({
      kind: "singleton",
      pageKey: "home",
      blocks: [{
        id: "products",
        type: "productGrid",
        props: { heading: "Featured" },
        layout: { x: 0, y: 0, w: 12, h: 4 },
      }],
    })).toEqual([{ id: "products", kind: "products", title: "Featured" }]);
  });

  it("uses the local storefront route in development", async () => {
    vi.stubEnv("NODE_ENV", "development");
    await expect(requirePublishableTenantDomain("demo-shop")).resolves.toBe("/storefront");
  });
});
