import { describe, it, expect } from "vitest";
import { buildProductDraft } from "../writer.server";
import { metaFromDraft } from "../render.server";
import type { StoreProduct } from "~/lib/storefront/catalog";
import type { StoreSettings } from "~/lib/storefront/settings.server";

const store: StoreSettings = {
  shopId: "s1", storeName: "Ember House", logoUrl: null,
  palette: { primary: "#111", background: "#fff", text: "#111" },
  voiceTagline: "Candles.", vibe: "classic" as StoreSettings["vibe"], typeStyle: "classic" as StoreSettings["typeStyle"], density: "standard" as StoreSettings["density"],
};
const product: StoreProduct = {
  id: "p1", handle: "cedar-bloom", title: "Cedar Bloom Candle", description: "Soy candle.",
  images: [{ url: "https://img/1.webp", alt: null }],
  variants: [{ id: "v1", sku: "CB", title: "8oz", priceCents: 3200, currency: "EUR", available: true }],
  collections: [],
};

describe("PDP meta composition", () => {
  it("returns descriptors with the product title, canonical and a Product JSON-LD", () => {
    const m = metaFromDraft(buildProductDraft(product, store, "https://ember.calderyncompany.com"));
    expect(m).toContainEqual({ title: "Cedar Bloom Candle · Ember House" });
    expect(m).toContainEqual({ tagName: "link", rel: "canonical", href: "https://ember.calderyncompany.com/storefront/products/cedar-bloom" });
    expect(m.some((d) => "script:ld+json" in (d as object))).toBe(true);
  });
});
