import { describe, it, expect } from "vitest";
import { validateDraft } from "../validator.server";
import type { SeoDraft } from "../types";

function draft(over: Partial<SeoDraft> = {}): SeoDraft {
  return {
    title: "Cedar Bloom Candle · Ember House",
    description: "Hand-poured cedar and bergamot soy candle, made in small batches in Amsterdam.",
    canonical: "https://ember.calderyncompany.com/storefront/products/cedar-bloom",
    ogImage: "https://img/1.webp", ogType: "product", imageAlts: ["a"],
    jsonLd: [{ "@context": "https://schema.org", "@type": "Product", name: "Cedar Bloom", offers: { "@context": "https://schema.org", "@type": "Offer", price: "32.00", priceCurrency: "EUR", availability: "https://schema.org/InStock" } }],
    ...over,
  };
}

describe("validateDraft", () => {
  it("returns no issues for a well-formed draft", () => {
    expect(validateDraft(draft())).toEqual([]);
  });
  it("flags a too-short title", () => {
    expect(validateDraft(draft({ title: "Hi" })).some((i) => i.field === "title")).toBe(true);
  });
  it("flags a too-long description", () => {
    expect(validateDraft(draft({ description: "x".repeat(200) })).some((i) => i.field === "description")).toBe(true);
  });
  it("flags a non-absolute canonical", () => {
    expect(validateDraft(draft({ canonical: "/relative" })).some((i) => i.field === "canonical")).toBe(true);
  });
  it("flags a Product node missing required schema fields", () => {
    expect(validateDraft(draft({ jsonLd: [{ "@context": "https://schema.org", "@type": "Product" }] }))
      .some((i) => i.field === "jsonLd")).toBe(true);
  });
  it("flags a node missing @context", () => {
    expect(validateDraft(draft({ jsonLd: [{ "@type": "Product", name: "x" } as unknown as SeoDraft["jsonLd"][number]] }))
      .some((i) => i.field === "jsonLd")).toBe(true);
  });
});
