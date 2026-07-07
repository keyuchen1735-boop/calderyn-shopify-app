import { describe, it, expect } from "vitest";
import { scoreDraft } from "../score.server";
import type { SeoDraft } from "../types";

function good(): SeoDraft {
  return {
    title: "Cedar Bloom Candle · Ember House",
    description: "Hand-poured cedar and bergamot soy candle, made in small batches in Amsterdam.",
    canonical: "https://ember.calderyncompany.com/storefront/products/cedar-bloom",
    ogImage: "https://img/1.webp", ogType: "product", imageAlts: ["Cedar Bloom Candle, Ember House"],
    jsonLd: [
      { "@context": "https://schema.org", "@type": "Product", name: "Cedar Bloom", offers: { "@context": "https://schema.org", "@type": "Offer", price: "32.00", priceCurrency: "EUR", availability: "https://schema.org/InStock" } },
      { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [] },
    ],
  };
}

describe("scoreDraft", () => {
  it("scores a complete draft at 100 with all checks passing", () => {
    const r = scoreDraft(good());
    expect(r.score).toBe(100);
    expect(r.checks.every((c) => c.status === "pass")).toBe(true);
  });
  it("drops the score and fails the alt-text check when an alt is blank", () => {
    const r = scoreDraft({ ...good(), imageAlts: ["Cedar Bloom Candle, Ember House", ""] });
    expect(r.score).toBeLessThan(100);
    const alt = r.checks.find((c) => c.id === "alt");
    expect(alt?.status).toBe("fail");
    expect(alt?.hint).toBeTruthy();
  });
  it("fails the ogImage and schema checks when they are missing", () => {
    const r = scoreDraft({ ...good(), ogImage: null, jsonLd: [] });
    expect(r.checks.find((c) => c.id === "ogImage")?.status).toBe("fail");
    expect(r.checks.find((c) => c.id === "schema")?.status).toBe("fail");
  });
});
