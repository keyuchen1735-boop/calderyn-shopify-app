import { describe, it, expect } from "vitest";
import { metaFromDraft, safeMetaFromDraft } from "../render.server";
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

describe("safeMetaFromDraft", () => {
  it("leaves a draft with valid structured data unchanged", () => {
    const d = draft({ description: "Hand-poured cedar and bergamot soy candle from Amsterdam." });
    expect(safeMetaFromDraft(d)).toEqual(metaFromDraft(d));
  });
  it("drops only the invalid JSON-LD node (empty Product.name) but still serves meta tags + valid schema", () => {
    const d = draft({
      jsonLd: [
        { "@context": "https://schema.org", "@type": "Product", name: "" }, // invalid: Product.name required
        { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [] }, // valid
      ],
    });
    const m = safeMetaFromDraft(d);
    const ldTypes = m
      .filter((x) => "script:ld+json" in (x as object))
      .map((x) => (x as Record<string, { "@type": string }>)["script:ld+json"]["@type"]);
    expect(ldTypes).toEqual(["BreadcrumbList"]); // the bad Product node is stripped
    // The human-facing meta tags always ship (title/description are advisory, not gated).
    expect(m).toContainEqual({ title: d.title });
    expect(m).toContainEqual({ tagName: "link", rel: "canonical", href: d.canonical });
  });
});
