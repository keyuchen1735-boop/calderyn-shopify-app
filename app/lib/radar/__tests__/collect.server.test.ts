import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpcMock: vi.fn(),
  fromMock: vi.fn(),
  getProductMock: vi.fn(),
  getStoreSettingsMock: vi.fn(),
  getShopStorefrontOriginMock: vi.fn(),
  getSeoSettingsMock: vi.fn(),
  releaseStateMock: vi.fn(),
  listRecentDiffsMock: vi.fn(),
}));
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({ rpc: mocks.rpcMock, from: mocks.fromMock }),
}));
vi.mock("~/lib/storefront/catalog.server", () => ({
  getCatalog: () => ({ getProduct: mocks.getProductMock }),
}));
vi.mock("~/lib/storefront/settings.server", () => ({ getStoreSettings: mocks.getStoreSettingsMock }));
vi.mock("~/lib/storefront/shop.server", () => ({ getShopStorefrontOrigin: mocks.getShopStorefrontOriginMock }));
vi.mock("~/lib/seo/seo-store.server", () => ({ getSeoSettings: mocks.getSeoSettingsMock }));
vi.mock("~/lib/storefront-bundle/build.server", () => ({ readStorefrontReleaseState: mocks.releaseStateMock }));
vi.mock("../competitor-store.server", () => ({ listRecentDiffs: mocks.listRecentDiffsMock }));

// eslint-disable-next-line import/first -- import must follow vi.mock so the mocks register first
import { collectShop, loadRadarInputs, JSONLD_CHECK_MAX_PAGES } from "../collect.server";

const SHOP = "11111111-2222-3333-4444-555555555555";

// Chainable query stub: every builder method returns itself; awaiting resolves
// to the queued result for its table.
function tableStub(result: { data: unknown; error: null | { message: string } }) {
  const q: Record<string, unknown> = {};
  for (const m of ["select", "eq", "gte", "lt", "order", "limit"]) {
    q[m] = vi.fn().mockReturnValue(q);
  }
  q.maybeSingle = vi.fn().mockResolvedValue(result);
  q.upsert = vi.fn().mockResolvedValue({ error: null });
  q.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return q;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rpcMock.mockResolvedValue({ data: [], error: null });
  mocks.getStoreSettingsMock.mockResolvedValue({ storeName: "Peak", logoUrl: null, voiceTagline: null, palette: { primary: "", background: "", text: "" } });
  mocks.getShopStorefrontOriginMock.mockResolvedValue("https://peak.example");
  mocks.getSeoSettingsMock.mockResolvedValue({ allowAiCrawlers: true, orgDescription: "We sell boots." });
  mocks.releaseStateMock.mockResolvedValue({ draftVersionId: null, publishedVersionId: null, draftRuntimeVersion: null, publishedRuntimeVersion: null });
  mocks.listRecentDiffsMock.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("collectShop", () => {
  it("runs the rollup RPC then stamps the cursor", async () => {
    const state = tableStub({ data: null, error: null });
    mocks.fromMock.mockReturnValue(state);
    await collectShop(SHOP);
    expect(mocks.rpcMock).toHaveBeenCalledWith("radar_rollup_traffic", { p_shop: SHOP, p_days: 10 });
    expect(mocks.fromMock).toHaveBeenCalledWith("radar_state");
    expect(state.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ shop_id: SHOP, last_collected_at: expect.any(String) }),
      { onConflict: "shop_id" },
    );
  });
  it("skips demo (non-uuid) shops and surfaces RPC errors", async () => {
    await collectShop("demo-shop");
    expect(mocks.rpcMock).not.toHaveBeenCalled();
    mocks.rpcMock.mockResolvedValueOnce({ data: null, error: { message: "boom" } });
    await expect(collectShop(SHOP)).rejects.toThrow(/boom/);
  });
});

describe("loadRadarInputs", () => {
  it("skips demo (non-uuid) shops and returns empty shape without calling supabase", async () => {
    const inputs = await loadRadarInputs("demo-shop");
    expect(inputs).toEqual({
      traffic: [],
      rankings: [],
      aiCrawl: [],
      allowAiCrawlers: false,
      hasOrgDescription: false,
      lastPublishedAt: null,
      jsonLdIssues: [],
      publishedRuntimeVersion: null,
      competitorDiffs: [],
    });
    expect(mocks.fromMock).not.toHaveBeenCalled();
    expect(mocks.rpcMock).not.toHaveBeenCalled();
  });
  it("assembles traffic, rankings, crawl, flags and JSON-LD checks", async () => {
    const traffic = tableStub({
      data: [{
        day: "2026-07-18", views: 100, sessions: 80, cart_adds: 3, checkouts: 1,
        top_paths: [{ path: "/storefront/products/mug", views: 90, cartAdds: 3, productId: "p1" }],
      }],
      error: null,
    });
    const crawl = tableStub({ data: [{ bot_name: "GPTBot", day: "2026-07-10", hits: 4 }], error: null });
    const pageDoc = tableStub({ data: { updated_at: "2026-06-01T00:00:00Z", published_json: { kind: "singleton" } }, error: null });
    mocks.fromMock.mockImplementation((table: string) => {
      if (table === "radar_traffic_daily") return traffic;
      if (table === "seo_ai_crawl_daily") return crawl;
      if (table === "page_document") return pageDoc;
      throw new Error(`unexpected table ${table}`);
    });
    mocks.rpcMock.mockResolvedValue({
      data: [{ pageUrl: "https://x/storefront/products/mug", query: "mug", days: [] }],
      error: null,
    });
    // Product with no sellable variants: the real writer emits Product JSON-LD
    // without offers, which passes; force an issue via a missing name instead.
    mocks.getProductMock.mockResolvedValue({
      id: "p1", handle: "mug", title: "", description: "", images: [], variants: [], collections: [],
    });
    const inputs = await loadRadarInputs(SHOP);
    expect(inputs.traffic).toEqual([{
      day: "2026-07-18", views: 100, sessions: 80, cartAdds: 3, checkouts: 1,
      topPaths: [{ path: "/storefront/products/mug", views: 90, cartAdds: 3, productId: "p1" }],
    }]);
    expect(inputs.rankings).toHaveLength(1);
    expect(inputs.aiCrawl).toEqual([{ botName: "GPTBot", day: "2026-07-10", hits: 4 }]);
    expect(inputs.allowAiCrawlers).toBe(true);
    expect(inputs.hasOrgDescription).toBe(true);
    expect(inputs.lastPublishedAt).toBe("2026-06-01T00:00:00Z");
    expect(inputs.publishedRuntimeVersion).toBeNull(); // legacy runtime (release stub default)
    expect(mocks.getProductMock).toHaveBeenCalledWith(SHOP, "mug");
    expect(inputs.jsonLdIssues[0]).toMatchObject({ productId: "p1", handle: "mug" });
    expect(inputs.jsonLdIssues[0].issues.length).toBeGreaterThan(0);
  });
  it("uses the published bundle version's created_at on runtime 1", async () => {
    const traffic = tableStub({ data: [], error: null });
    const crawl = tableStub({ data: [], error: null });
    const version = tableStub({ data: { created_at: "2026-07-01T00:00:00Z" }, error: null });
    mocks.fromMock.mockImplementation((table: string) => {
      if (table === "radar_traffic_daily") return traffic;
      if (table === "seo_ai_crawl_daily") return crawl;
      if (table === "storefront_bundle_version") return version;
      throw new Error(`unexpected table ${table}`);
    });
    mocks.releaseStateMock.mockResolvedValue({
      draftVersionId: null, publishedVersionId: "22222222-2222-3333-4444-555555555555",
      draftRuntimeVersion: null, publishedRuntimeVersion: 1,
    });
    const inputs = await loadRadarInputs(SHOP);
    expect(inputs.lastPublishedAt).toBe("2026-07-01T00:00:00Z");
    expect(inputs.publishedRuntimeVersion).toBe(1);
    expect(inputs.jsonLdIssues).toEqual([]); // no traffic -> no pages to check
  });
  it("caps the JSON-LD sweep", () => {
    expect(JSONLD_CHECK_MAX_PAGES).toBe(10);
  });
  it("excludes the current UTC day's partial row (radar_rollup_traffic writes a same-day row at cron time)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-19T10:00:00Z"));
    const traffic = tableStub({
      data: [
        { day: "2026-07-18", views: 100, sessions: 80, cart_adds: 3, checkouts: 1, top_paths: [] },
        // Today - only ~10h of data has accumulated by cron time. Must never be
        // treated as a complete "yesterday" by detectors.
        { day: "2026-07-19", views: 12, sessions: 9, cart_adds: 0, checkouts: 0, top_paths: [] },
      ],
      error: null,
    });
    const crawl = tableStub({ data: [], error: null });
    const pageDoc = tableStub({ data: null, error: null });
    mocks.fromMock.mockImplementation((table: string) => {
      if (table === "radar_traffic_daily") return traffic;
      if (table === "seo_ai_crawl_daily") return crawl;
      if (table === "page_document") return pageDoc;
      throw new Error(`unexpected table ${table}`);
    });
    mocks.rpcMock.mockResolvedValue({ data: [], error: null });
    const inputs = await loadRadarInputs(SHOP);
    expect(inputs.traffic).toEqual([{
      day: "2026-07-18", views: 100, sessions: 80, cartAdds: 3, checkouts: 1, topPaths: [],
    }]);
    expect(inputs.traffic.some((d) => d.day === "2026-07-19")).toBe(false);
    expect(traffic.lt).toHaveBeenCalledWith("day", "2026-07-19");
  });
});
