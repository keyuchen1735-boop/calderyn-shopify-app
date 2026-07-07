import { describe, it, expect } from "vitest";
import {
  offerNode, aggregateOfferNode, productJsonLd, organizationJsonLd, webSiteJsonLd, collectionJsonLd, breadcrumbJsonLd,
} from "../jsonld.server";

const URL0 = "https://ember.calderyncompany.com/storefront/products/cedar";

describe("jsonld builders", () => {
  it("offerNode formats price from cents and maps availability", () => {
    const o = offerNode({ priceCents: 3200, currency: "EUR", available: true, sku: "CB-8", url: URL0 });
    expect(o).toMatchObject({
      "@type": "Offer", price: "32.00", priceCurrency: "EUR",
      availability: "https://schema.org/InStock", sku: "CB-8", url: URL0,
    });
  });
  it("offerNode marks sold-out as OutOfStock", () => {
    expect(offerNode({ priceCents: 1000, currency: "USD", available: false, url: URL0 }).availability)
      .toBe("https://schema.org/OutOfStock");
  });
  it("aggregateOfferNode carries low/high/offerCount", () => {
    expect(aggregateOfferNode({ lowCents: 1800, highCents: 4200, currency: "EUR", offerCount: 3, anyAvailable: true }))
      .toMatchObject({ "@type": "AggregateOffer", lowPrice: "18.00", highPrice: "42.00", priceCurrency: "EUR", offerCount: 3, availability: "https://schema.org/InStock" });
  });
  it("productJsonLd nests name, image array and the offers node", () => {
    const offers = offerNode({ priceCents: 3200, currency: "EUR", available: true, url: URL0 });
    const node = productJsonLd({ name: "Cedar Bloom", description: "Soy candle.", url: URL0, images: ["https://img/1.webp"], offers });
    expect(node).toMatchObject({ "@context": "https://schema.org", "@type": "Product", name: "Cedar Bloom", image: ["https://img/1.webp"], offers });
  });
  it("productJsonLd omits offers key when not purchasable", () => {
    const node = productJsonLd({ name: "X", description: "", url: URL0, images: [], offers: null });
    expect("offers" in node).toBe(false);
  });
  it("organizationJsonLd and webSiteJsonLd carry name+url", () => {
    expect(organizationJsonLd({ name: "Ember", url: "https://ember.calderyncompany.com", logo: "https://l/x.png", description: "Candles" }))
      .toMatchObject({ "@type": "Organization", name: "Ember", logo: "https://l/x.png", description: "Candles" });
    expect(webSiteJsonLd({ name: "Ember", url: "https://ember.calderyncompany.com" }))
      .toMatchObject({ "@type": "WebSite", name: "Ember" });
  });
  it("breadcrumbJsonLd builds positioned ListItems", () => {
    const node = breadcrumbJsonLd([{ name: "Home", url: "https://x/" }, { name: "Cedar", url: URL0 }]);
    expect(node["@type"]).toBe("BreadcrumbList");
    expect((node.itemListElement as unknown[]).length).toBe(2);
    expect((node.itemListElement as Array<{ position: number }>)[1].position).toBe(2);
  });
});
