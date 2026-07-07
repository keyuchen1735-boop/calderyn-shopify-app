import { describe, it, expect, vi } from "vitest";

vi.mock("../../storefront/catalog.server", () => ({
  getCatalog: () => ({
    listProducts: async () => [
      { id: "p1", handle: "cedar-bloom", title: "Cedar Bloom", description: "Soy candle", images: [], variants: [{ id: "v1", sku: null, title: "8oz", priceCents: 3200, currency: "EUR", available: true }], collections: [] },
      { id: "p2", handle: "vanilla", title: "Vanilla 8oz", description: "", images: [], variants: [{ id: "v2", sku: null, title: "8oz", priceCents: 2500, currency: "EUR", available: false }], collections: [] },
    ],
    listCollections: async () => [{ handle: "soy", title: "Soy Candles" }],
    getProduct: async () => null,
  }),
}));

// eslint-disable-next-line import/first
import { buildRobotsTxt, buildSitemapXml, buildLlmsTxt } from "../site-files.server";
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

  it("disallows the AI bots when allowAiCrawlers is false, keeping generic crawlers allowed", () => {
    const txt = buildRobotsTxt(ORIGIN, false);
    expect(txt).toContain("User-agent: GPTBot\nDisallow: /");
    expect(txt).toContain("User-agent: *\nAllow: /");
    expect(txt).toContain(`Sitemap: ${ORIGIN}/sitemap.xml`);
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
});
