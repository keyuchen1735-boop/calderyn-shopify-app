import { describe, it, expect, vi } from "vitest";

vi.mock("../../storefront/catalog.server", () => ({
  getCatalog: () => ({
    listProducts: async () => [
      { id: "p1", handle: "cedar-bloom", title: "Cedar Bloom", description: "Soy candle", images: [], variants: [{ id: "v1", sku: null, title: "8oz", priceCents: 3200, currency: "EUR", available: true }], collections: [] },
      { id: "p2", handle: "vanilla", title: "Vanilla 8oz", description: "", images: [], variants: [{ id: "v2", sku: null, title: "8oz", priceCents: 2500, currency: "EUR", available: false }], collections: [] },
      // Only in-stock variant is a $0 sample; the buyable price (40.00) is out of stock.
      { id: "p3", handle: "sampler", title: "Sampler", description: "", images: [], variants: [
        { id: "v3", sku: null, title: "sample", priceCents: 0, currency: "EUR", available: true },
        { id: "v4", sku: null, title: "full", priceCents: 4000, currency: "EUR", available: false },
      ], collections: [] },
    ],
    listCollections: async () => [{ handle: "soy", title: "Soy Candles" }],
    getProduct: async () => null,
  }),
}));

// eslint-disable-next-line import/first
import { buildRobotsTxt, buildSitemapXml, buildLlmsTxt } from "../site-files.server";
// eslint-disable-next-line import/first
import { AI_BOT_NAMES } from "../crawlers.server";
// eslint-disable-next-line import/first
import type { StoreSettings } from "~/lib/storefront/settings.server";

const ORIGIN = "https://ember.calderyncompany.com";
const store: StoreSettings = {
  shopId: "s1", storeName: "Ember House", logoUrl: null,
  palette: { primary: "#111", background: "#fff", text: "#111" },
  voiceTagline: "Small-batch soy candles from Amsterdam.",
  vibe: "classic" as StoreSettings["vibe"], typeStyle: "classic" as StoreSettings["typeStyle"], density: "standard" as StoreSettings["density"],
};

describe("buildRobotsTxt", () => {
  it("allows crawlers, names AI bots, and links the sitemap", () => {
    const txt = buildRobotsTxt(ORIGIN);
    expect(txt).toContain("User-agent: *");
    expect(txt).toContain("Allow: /");
    expect(txt).toContain("User-agent: GPTBot");
    expect(txt).toContain(`Sitemap: ${ORIGIN}/sitemap.xml`);
  });

  it("disallows EVERY detected AI bot when allowAiCrawlers is false, keeping generic crawlers allowed", () => {
    const txt = buildRobotsTxt(ORIGIN, false);
    // The robots block and the UA detector share one canonical list: turning AI
    // access off must block all of them, not just the well-known few.
    expect(AI_BOT_NAMES.length).toBe(13);
    for (const bot of AI_BOT_NAMES) {
      expect(txt).toContain(`User-agent: ${bot}\nDisallow: /`);
    }
    // Bots that the old short list missed are now covered.
    for (const bot of ["Bytespider", "CCBot", "Amazonbot", "cohere-ai", "anthropic-ai", "Claude-User", "Perplexity-User"]) {
      expect(txt).toContain(`User-agent: ${bot}\nDisallow: /`);
    }
    expect(txt).toContain("User-agent: *\nAllow: /");
    expect(txt).toContain(`Sitemap: ${ORIGIN}/sitemap.xml`);
  });

  it("disallows generic crawlers when allowSearchEngines is false, independently of the AI switch", () => {
    // AI on, search off: the `User-agent: *` block flips to Disallow while the AI
    // bots stay allowed — the two switches are independent.
    const txt = buildRobotsTxt(ORIGIN, true, false);
    expect(txt).toContain("User-agent: *\nDisallow: /");
    expect(txt).toContain(`User-agent: GPTBot\nAllow: /`);
  });
});

describe("buildSitemapXml", () => {
  it("lists home + product + collection URLs as valid XML", async () => {
    const xml = await buildSitemapXml("s1", ORIGIN);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain("<loc>https://ember.calderyncompany.com/storefront</loc>");
    expect(xml).toContain("<loc>https://ember.calderyncompany.com/storefront/products/cedar-bloom</loc>");
    expect(xml).toContain("<loc>https://ember.calderyncompany.com/storefront/collections/soy</loc>");
  });
});

describe("buildLlmsTxt", () => {
  it("summarizes the store and lists products with prices for answer engines", async () => {
    const txt = await buildLlmsTxt("s1", store, ORIGIN);
    expect(txt).toContain("# Ember House");
    expect(txt).toContain("Small-batch soy candles from Amsterdam.");
    expect(txt).toContain("[Cedar Bloom](https://ember.calderyncompany.com/storefront/products/cedar-bloom)");
    expect(txt).toContain("32.00 EUR");
    expect(txt).toContain("Out of stock"); // vanilla is unavailable
  });

  it("reports a sellable price as out of stock when only a $0 sample is available", async () => {
    const txt = await buildLlmsTxt("s1", store, ORIGIN);
    // The paid variant (40.00) is out of stock; the free sample must not make the
    // buyable price read as "In stock".
    expect(txt).toContain("[Sampler](https://ember.calderyncompany.com/storefront/products/sampler): 40.00 EUR, Out of stock");
  });
});
