import { describe, it, expect } from "vitest";
import { buildProductDraft } from "../writer.server";
import { applyOverride } from "../override";
import { metaFromDraft } from "../render.server";
import type { StoreProduct } from "~/lib/storefront/catalog";
import type { StoreSettings } from "~/lib/storefront/settings.server";

const store: StoreSettings = {
  shopId: "s1", storeName: "Ember House", logoUrl: null,
  palette: { primary: "#111", background: "#fff", text: "#111" },
  voiceTagline: "Candles.", vibe: "minimal" as StoreSettings["vibe"], typeStyle: "classic" as StoreSettings["typeStyle"], density: "standard" as StoreSettings["density"],
};
const product: StoreProduct = {
  id: "p1", handle: "cedar-bloom", title: "Cedar Bloom Candle", description: "Soy candle.",
  images: [{ url: "https://img/1.webp", alt: null }],
  variants: [{ id: "v1", sku: "CB", title: "8oz", priceCents: 3200, currency: "EUR", available: true }],
  collections: [],
};
const ORIGIN = "https://ember.calderyncompany.com";

describe("override + render", () => {
  it("og:title/description follow the overridden values", () => {
    const draft = applyOverride(
      buildProductDraft(product, store, ORIGIN),
      { metaTitle: "Custom Title", metaDescription: "Custom description that sells." },
    );
    const m = metaFromDraft(draft);
    expect(m).toContainEqual({ title: "Custom Title" });
    expect(m).toContainEqual({ property: "og:title", content: "Custom Title" });
    expect(m).toContainEqual({ name: "description", content: "Custom description that sells." });
    expect(m).toContainEqual({ property: "og:description", content: "Custom description that sells." });
    // Canonical is engine-owned and unchanged by an override.
    expect(m).toContainEqual({ tagName: "link", rel: "canonical", href: `${ORIGIN}/storefront/products/cedar-bloom` });
  });
});
