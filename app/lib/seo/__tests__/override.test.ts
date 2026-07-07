// app/lib/seo/__tests__/override.test.ts
import { describe, it, expect } from "vitest";
import { applyOverride } from "../override";
import type { SeoDraft } from "../types";

const base: SeoDraft = {
  title: "Gen Title · Store",
  description: "Generated description that is long enough to pass.",
  canonical: "https://x/storefront/products/p",
  ogImage: "https://img/1.webp", ogType: "product", imageAlts: [],
  jsonLd: [{ "@context": "https://schema.org", "@type": "Product", name: "P" }],
};

describe("applyOverride", () => {
  it("returns the draft unchanged when the override is null", () => {
    expect(applyOverride(base, null)).toEqual(base);
  });
  it("overrides title and description, leaving canonical + JSON-LD untouched", () => {
    const d = applyOverride(base, { metaTitle: "My Title", metaDescription: "My description." });
    expect(d.title).toBe("My Title");
    expect(d.description).toBe("My description.");
    expect(d.canonical).toBe(base.canonical);
    expect(d.jsonLd).toBe(base.jsonLd);
  });
  it("overrides only the provided field, keeping the other generated", () => {
    const d = applyOverride(base, { metaTitle: "Only Title", metaDescription: null });
    expect(d.title).toBe("Only Title");
    expect(d.description).toBe(base.description);
  });
  it("ignores blank override strings", () => {
    expect(applyOverride(base, { metaTitle: "   ", metaDescription: "" })).toEqual(base);
  });
});
