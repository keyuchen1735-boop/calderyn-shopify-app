import { describe, it, expect } from "vitest";
import { metaFromDraft } from "../render.server";
import type { SeoDraft } from "../types";

function draft(over: Partial<SeoDraft> = {}): SeoDraft {
  return {
    title: "Cedar Bloom Candle · Ember House",
    description: "Hand-poured cedar and bergamot soy candle.",
    canonical: "https://ember.calderyncompany.com/storefront/products/cedar-bloom",
    ogImage: "https://img/1.webp", ogType: "product", imageAlts: [],
    jsonLd: [{ "@context": "https://schema.org", "@type": "Product", name: "Cedar Bloom" }],
    ...over,
  };
}

describe("metaFromDraft", () => {
  it("emits title, description, canonical link, OG/Twitter tags and one ld+json per node", () => {
    const m = metaFromDraft(draft());
    expect(m).toContainEqual({ title: "Cedar Bloom Candle · Ember House" });
    expect(m).toContainEqual({ name: "description", content: "Hand-poured cedar and bergamot soy candle." });
    expect(m).toContainEqual({ tagName: "link", rel: "canonical", href: "https://ember.calderyncompany.com/storefront/products/cedar-bloom" });
    expect(m).toContainEqual({ property: "og:type", content: "product" });
    expect(m).toContainEqual({ property: "og:image", content: "https://img/1.webp" });
    expect(m).toContainEqual({ name: "twitter:card", content: "summary_large_image" });
    expect(m.filter((d) => "script:ld+json" in (d as object))).toHaveLength(1);
  });
  it("omits og:image and uses summary card when there is no image", () => {
    const m = metaFromDraft(draft({ ogImage: null }));
    expect(m.some((d) => (d as { property?: string }).property === "og:image")).toBe(false);
    expect(m).toContainEqual({ name: "twitter:card", content: "summary" });
  });
});
