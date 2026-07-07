// app/lib/seo/__tests__/overview.server.test.ts
import { describe, it, expect, vi } from "vitest";
import type { StoreProduct } from "~/lib/storefront/catalog";
import type { StoreSettings } from "~/lib/storefront/settings.server";

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
  getSeoSettings: async () => ({ allowAiCrawlers: true, allowAiTraining: false, orgName: null, orgDescription: null }),
}));
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
    expect(vm.storeHealth).toBe(86); // round((100 + 71) / 2)
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
