// app/lib/seo/__tests__/overview.server.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StoreProduct } from "~/lib/storefront/catalog";
import type { StoreSettings } from "~/lib/storefront/settings.server";
import type * as GoogleSearchConsoleServer from "../google-search-console.server";

const ORIGIN = "https://ember.calderyncompany.com";
const store: StoreSettings = {
  shopId: "s1", storeName: "Ember House", logoUrl: null,
  palette: { primary: "#111", background: "#fff", text: "#111" },
  voiceTagline: "Small-batch soy candles from Amsterdam.",
  vibe: "minimal" as StoreSettings["vibe"], typeStyle: "classic" as StoreSettings["typeStyle"], density: "standard" as StoreSettings["density"],
};
// Product A is complete (scores 100); Product B has no image + empty description
// (share-image and meta-description checks fail => below 100).
const good: StoreProduct = {
  id: "p1", handle: "cedar-bloom", title: "Cedar Bloom Candle",
  description: "Hand-poured cedar and bergamot soy candle, made in small batches in Amsterdam.",
  images: [{ url: "https://img/1.webp", alt: "Cedar" }],
  variants: [{ id: "v1", sku: "CB", title: "8oz", priceCents: 3200, currency: "EUR", available: true }],
  collections: [],
};
const weak: StoreProduct = {
  id: "p2", handle: "plain", title: "Plain",
  description: "",
  images: [],
  variants: [{ id: "v2", sku: null, title: "x", priceCents: 0, currency: "EUR", available: false }],
  collections: [],
};

vi.mock("../../storefront/catalog.server", () => ({
  getCatalog: () => ({
    listProducts: async () => [good, weak],
    getProduct: async (_s: string, h: string) => [good, weak].find((p) => p.handle === h) ?? null,
    listCollections: async () => [],
  }),
}));
vi.mock("../../storefront/settings.server", () => ({ getStoreSettings: async () => store }));
vi.mock("../seo-store.server", () => ({
  listSeoOverrides: async () => new Map(),
  getSeoOverride: async () => null,
  getSeoSettings: async () => ({ allowSearchEngines: true, allowAiCrawlers: true, orgName: null, orgDescription: null }),
}));
const { getGscStateMock, getRankingsSinceMock } = vi.hoisted(() => ({
  getGscStateMock: vi.fn(),
  getRankingsSinceMock: vi.fn(),
}));
// Two captures of the same query on Product A ("cedar-bloom"): position 3 -> 11,
// a slip (delta 8 >= the default threshold of 5).
const rankingRows = [
  { query: "cedar candle", pageUrl: "https://ember.calderyncompany.com/storefront/products/cedar-bloom", position: 3, impressions: 100, clicks: 8, ctr: 0.08, capturedDate: "2026-06-01" },
  { query: "cedar candle", pageUrl: "https://ember.calderyncompany.com/storefront/products/cedar-bloom", position: 11, impressions: 90, clicks: 2, ctr: 0.02, capturedDate: "2026-06-20" },
];
vi.mock("../google-search-console.server", async () => {
  const actual = await vi.importActual<typeof GoogleSearchConsoleServer>("../google-search-console.server");
  return {
    ...actual, // keep the REAL summariseGoogleCard / detectSlips so the math is exercised
    getGscState: getGscStateMock,
    getRankingsSince: getRankingsSinceMock,
  };
});
// Most tests want the disconnected default set in beforeEach so they stay
// unaffected by Google data; only the Google-card tests opt into this fixture.
function connectGoogleFixture() {
  getGscStateMock.mockResolvedValue({ connected: true, siteUrl: "https://ember.calderyncompany.com/" });
  getRankingsSinceMock.mockResolvedValue(rankingRows);
}
beforeEach(() => {
  getGscStateMock.mockReset().mockResolvedValue({ connected: false, siteUrl: null });
  getRankingsSinceMock.mockReset().mockResolvedValue([]);
});
vi.mock("../../supabase.server", () => ({
  getSupabase: () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {
        select() { return b; },
        eq() { return b; },
        gte() { return b; },
        async maybeSingle() { return table === "shops" ? { data: { org_slug: "ember" }, error: null } : { data: null, error: null }; },
        then(res: (v: { data: unknown[]; error: null }) => void) {
          if (table === "seo_ai_crawl_daily") {
            res({ data: [{ bot_name: "GPTBot", hits: 3 }, { bot_name: "PerplexityBot", hits: 2 }, { bot_name: "GPTBot", hits: 4 }], error: null });
          } else {
            res({ data: [], error: null });
          }
        },
      };
      return b;
    },
  }),
}));

// eslint-disable-next-line import/first -- imports must follow vi.mock
import { buildSeoOverview, getProductSeoDetail, getShopStorefrontOrigin } from "../overview.server";

const SHOP = "11111111-2222-3333-4444-555555555555";

describe("getShopStorefrontOrigin", () => {
  it("builds the tenant origin from org_slug", async () => {
    expect(await getShopStorefrontOrigin(SHOP)).toBe("https://ember.calderyncompany.com");
  });
  it("returns a relative base for a non-uuid shop", async () => {
    expect(await getShopStorefrontOrigin("demo-shop")).toBe("");
  });
});

describe("buildSeoOverview", () => {
  it("averages product health and lists only sub-100 pages worst-first", async () => {
    const vm = await buildSeoOverview(SHOP, ORIGIN);
    expect(vm.productCount).toBe(2);
    expect(vm.storeHealth).toBe(93); // round((100 + 86) / 2); the empty-body product now gets a healthy default description
    expect(vm.needsAttention.map((r) => r.id)).toEqual(["p2"]);
    expect(vm.needsAttention[0].score).toBeLessThan(100);
    expect(vm.needsAttention[0].topIssue).toBeTruthy();
    expect(vm.needsAttention[0].hasOverride).toBe(false);
  });
  it("summarizes AI crawls per bot, descending, with a total", async () => {
    const vm = await buildSeoOverview(SHOP, ORIGIN);
    expect(vm.aiCrawls).toEqual([{ botName: "GPTBot", hits: 7 }, { botName: "PerplexityBot", hits: 2 }]);
    expect(vm.aiCrawlTotal).toBe(9);
  });
  it("keeps the disconnected placeholder card and does zero ranking work when not connected", async () => {
    const vm = await buildSeoOverview(SHOP, ORIGIN);
    expect(vm.google).toEqual({ connected: false, clicks: 0, impressions: 0, topQuery: null, topPosition: null });
    expect(getRankingsSinceMock).not.toHaveBeenCalled();
  });
  it("populates the Google card from seo_ranking when connected", async () => {
    connectGoogleFixture();
    const vm = await buildSeoOverview(SHOP, ORIGIN);
    expect(vm.google.connected).toBe(true);
    expect(vm.google.clicks).toBe(10); // 8 + 2
    expect(vm.google.impressions).toBe(190); // 100 + 90
    expect(vm.google.topQuery).toBe("cedar candle");
  });
  it("adds a slipping product page to needsAttention", async () => {
    connectGoogleFixture();
    const vm = await buildSeoOverview(SHOP, ORIGIN);
    const slip = vm.needsAttention.find((r) => r.handle === "cedar-bloom");
    expect(slip).toBeTruthy();
    expect(slip?.topIssue).toMatch(/slipping on google/i);
  });
  it("merges a slip note into a page that also has a content issue, without dropping either or duplicating the row", async () => {
    getGscStateMock.mockResolvedValue({ connected: true, siteUrl: "https://ember.calderyncompany.com/" });
    // The weak product ("plain") already fails a content check (no share image);
    // a slip on the same page must be merged into that one row, not dropped.
    getRankingsSinceMock.mockResolvedValue([
      { query: "plain candle", pageUrl: "https://ember.calderyncompany.com/storefront/products/plain", position: 4, impressions: 60, clicks: 3, ctr: 0.05, capturedDate: "2026-06-01" },
      { query: "plain candle", pageUrl: "https://ember.calderyncompany.com/storefront/products/plain", position: 13, impressions: 40, clicks: 1, ctr: 0.02, capturedDate: "2026-06-20" },
    ]);
    const vm = await buildSeoOverview(SHOP, ORIGIN);
    const plainRows = vm.needsAttention.filter((r) => r.handle === "plain");
    expect(plainRows).toHaveLength(1); // one row per page
    expect(plainRows[0].topIssue).toMatch(/slipping on google/i); // slip surfaced
    expect(plainRows[0].topIssue).toMatch(/share image/i); // content issue preserved
  });
  it("falls back to an empty card and skips slip rows when the seo_ranking read fails", async () => {
    getGscStateMock.mockResolvedValue({ connected: true, siteUrl: "https://ember.calderyncompany.com/" });
    getRankingsSinceMock.mockRejectedValue(new Error("seo_ranking: connection reset"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const vm = await buildSeoOverview(SHOP, ORIGIN);
    expect(vm.google).toEqual({ connected: true, clicks: 0, impressions: 0, topQuery: null, topPosition: null });
    expect(vm.needsAttention.some((r) => r.handle === "cedar-bloom")).toBe(false);
    spy.mockRestore();
  });
});

describe("getProductSeoDetail", () => {
  it("returns a SERP preview, health report and a plain AI summary", async () => {
    const d = await getProductSeoDetail(SHOP, "cedar-bloom", ORIGIN);
    expect(d.id).toBe("p1");
    expect(d.googlePreview.title).toBe("Cedar Bloom Candle · Ember House");
    expect(d.googlePreview.url).toBe("https://ember.calderyncompany.com/storefront/products/cedar-bloom");
    expect(d.health.score).toBe(100);
    expect(d.override).toBeNull();
    expect(d.aiSummary).toContain("Ember House");
  });
  it("throws a 404 CalderynError for an unknown handle", async () => {
    await expect(getProductSeoDetail(SHOP, "nope", ORIGIN)).rejects.toMatchObject({ status: 404 });
  });
});
