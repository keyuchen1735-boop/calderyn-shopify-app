import { describe, it, expect } from "vitest";
import { buildProductDraft, buildHomeDraft, buildCollectionDraft, plainText, clampText } from "../writer.server";
import type { StoreProduct } from "~/lib/storefront/catalog";
import type { StoreSettings } from "~/lib/storefront/settings.server";

const store: StoreSettings = {
  shopId: "s1", storeName: "Ember House", logoUrl: "https://ember/logo.png",
  palette: { primary: "#111", background: "#fff", text: "#111" },
  voiceTagline: "Small-batch soy candles from Amsterdam.",
  vibe: "classic" as StoreSettings["vibe"], typeStyle: "classic" as StoreSettings["typeStyle"], density: "standard" as StoreSettings["density"],
};
const ORIGIN = "https://ember.calderyncompany.com";

function product(over: Partial<StoreProduct> = {}): StoreProduct {
  return {
    id: "p1", handle: "cedar-bloom", title: "Cedar Bloom Candle",
    description: "<p>Hand-poured <b>cedar</b> and bergamot soy candle.</p>",
    images: [{ url: "https://img/1.webp", alt: null }, { url: "https://img/2.webp", alt: "existing alt" }],
    variants: [{ id: "v1", sku: "CB-8", title: "8oz", priceCents: 3200, currency: "EUR", available: true }],
    collections: ["soy"], ...over,
  };
}

describe("text helpers", () => {
  it("plainText strips tags and collapses whitespace", () => {
    expect(plainText("<p>Hand-poured  <b>cedar</b></p>")).toBe("Hand-poured cedar");
  });
  it("clampText cuts on a word boundary within the limit", () => {
    expect(clampText("one two three four", 12)).toBe("one two");
  });
});

describe("buildProductDraft", () => {
  it("builds title, canonical, ogImage and a Product JSON-LD with a single Offer", () => {
    const d = buildProductDraft(product(), store, ORIGIN);
    expect(d.title).toBe("Cedar Bloom Candle · Ember House");
    expect(d.canonical).toBe("https://ember.calderyncompany.com/storefront/products/cedar-bloom");
    expect(d.ogImage).toBe("https://img/1.webp");
    expect(d.ogType).toBe("product");
    expect(d.description).toContain("Hand-poured cedar and bergamot");
    const prod = d.jsonLd.find((n) => n["@type"] === "Product");
    expect((prod?.offers as { "@type": string })["@type"]).toBe("Offer");
    expect(d.jsonLd.some((n) => n["@type"] === "BreadcrumbList")).toBe(true);
  });
  it("generates alt text only where the source alt is missing", () => {
    const d = buildProductDraft(product(), store, ORIGIN);
    expect(d.imageAlts[0]).toBe("Cedar Bloom Candle, Ember House");
    expect(d.imageAlts[1]).toBe("existing alt");
  });
  it("fills a natural default description that clears the 50-char health floor when the body is empty", () => {
    const d = buildProductDraft(product({ description: "" }), store, ORIGIN);
    expect(d.description.length).toBeGreaterThanOrEqual(50); // above the validator's DESC_MIN
    expect(d.description).toContain("Cedar Bloom Candle");
    expect(d.description).toContain("Ember House");
    expect(d.description).not.toMatch(/[—–]/); // no em/en dashes in merchant-facing copy
  });
  it("uses AggregateOffer for multiple distinct prices and skips $0 variants", () => {
    const d = buildProductDraft(product({
      variants: [
        { id: "v1", sku: null, title: "8oz", priceCents: 1800, currency: "EUR", available: true },
        { id: "v2", sku: null, title: "12oz", priceCents: 4200, currency: "EUR", available: false },
        { id: "v3", sku: null, title: "sample", priceCents: 0, currency: "EUR", available: true },
      ],
    }), store, ORIGIN);
    const prod = d.jsonLd.find((n) => n["@type"] === "Product");
    const offers = prod?.offers as { "@type": string; lowPrice: string; highPrice: string; offerCount: number };
    expect(offers["@type"]).toBe("AggregateOffer");
    expect(offers.lowPrice).toBe("18.00");
    expect(offers.highPrice).toBe("42.00");
    expect(offers.offerCount).toBe(2); // the $0 sample is excluded
  });
  it("has no offers node when nothing is purchasable", () => {
    const d = buildProductDraft(product({ variants: [{ id: "v1", sku: null, title: "x", priceCents: 0, currency: "EUR", available: true }] }), store, ORIGIN);
    const prod = d.jsonLd.find((n) => n["@type"] === "Product");
    expect("offers" in (prod ?? {})).toBe(false);
  });
});

describe("buildHomeDraft / buildCollectionDraft", () => {
  it("home draft emits Organization + WebSite and uses the tagline as description", () => {
    const d = buildHomeDraft(store, ORIGIN);
    expect(d.title).toBe("Ember House");
    expect(d.description).toBe("Small-batch soy candles from Amsterdam.");
    expect(d.canonical).toBe("https://ember.calderyncompany.com/storefront");
    expect(d.jsonLd.map((n) => n["@type"]).sort()).toEqual(["Organization", "WebSite"]);
  });
  it("collection draft canonical points at the collection path with a CollectionPage node", () => {
    const d = buildCollectionDraft({ handle: "soy", title: "Soy Candles" }, store, ORIGIN);
    expect(d.canonical).toBe("https://ember.calderyncompany.com/storefront/collections/soy");
    expect(d.title).toBe("Soy Candles · Ember House");
    expect(d.jsonLd.some((n) => n["@type"] === "CollectionPage")).toBe(true);
  });
});
