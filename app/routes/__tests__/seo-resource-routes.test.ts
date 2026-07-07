// app/routes/__tests__/seo-resource-routes.test.ts
import { describe, it, expect, vi } from "vitest";

vi.mock("~/lib/storefront/shop.server", () => ({ resolveStorefrontShop: async () => "s1", DEMO_SHOP_ID: "demo-shop" }));
vi.mock("~/lib/storefront/settings.server", () => ({
  getStoreSettings: async () => ({ shopId: "s1", storeName: "Ember House", logoUrl: null, palette: { primary: "#111", background: "#fff", text: "#111" }, voiceTagline: "Candles.", vibe: "classic", typeStyle: "classic", density: "standard" }),
}));
vi.mock("~/lib/seo/site-files.server", () => ({
  buildRobotsTxt: (origin: string) => `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`,
  buildSitemapXml: async () => '<?xml version="1.0" encoding="UTF-8"?><urlset></urlset>',
  buildLlmsTxt: async () => "# Ember House\n",
}));

// eslint-disable-next-line import/first -- imports must follow vi.mock
import { loader as robots } from "../[robots.txt]";
// eslint-disable-next-line import/first -- imports must follow vi.mock
import { loader as sitemap } from "../[sitemap.xml]";
// eslint-disable-next-line import/first -- imports must follow vi.mock
import { loader as llms } from "../[llms.txt]";

function req(host = "ember.calderyncompany.com") {
  return { request: new Request(`https://${host}/x`, { headers: { host } }), params: {}, context: {} };
}

describe("seo resource routes", () => {
  it("robots.txt is text/plain and links the sitemap", async () => {
    const res = await robots(req() as never);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toContain("Sitemap: https://ember.calderyncompany.com/sitemap.xml");
  });
  it("sitemap.xml is application/xml", async () => {
    const res = await sitemap(req() as never);
    expect(res.headers.get("content-type")).toContain("application/xml");
    expect(await res.text()).toContain("<urlset");
  });
  it("llms.txt is text/plain and starts with the store name heading", async () => {
    const res = await llms(req() as never);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toContain("# Ember House");
  });
});
