import { describe, it, expect } from "vitest";
import { normalizeStorefrontHref, type StorefrontLinkSet } from "./links";

const links: StorefrontLinkSet = {
  productHandles: new Set(["kettle", "the-6-quart"]),
  collectionHandles: new Set(["fireside"]),
};

describe("normalizeStorefrontHref", () => {
  it("keeps deep links whose handle exists in the catalog", () => {
    expect(normalizeStorefrontHref("/storefront/collections/fireside", links)).toBe("/storefront/collections/fireside");
    expect(normalizeStorefrontHref("/storefront/products/kettle", links)).toBe("/storefront/products/kettle");
  });

  it("rewrites an invented collection/product handle to the shop home", () => {
    expect(normalizeStorefrontHref("/storefront/collections/made-up", links)).toBe("/storefront");
    expect(normalizeStorefrontHref("/storefront/products/ghost", links)).toBe("/storefront");
  });

  it("preserves real handles even with a trailing query or hash", () => {
    expect(normalizeStorefrontHref("/storefront/products/kettle?ref=hero", links)).toBe("/storefront/products/kettle?ref=hero");
  });

  it("leaves the home, cart, anchors and external links untouched", () => {
    for (const href of ["/storefront", "/storefront/cart", "#story", "https://instagram.com/x", "mailto:a@b.co"]) {
      expect(normalizeStorefrontHref(href, links)).toBe(href);
    }
  });

  it("collapses a malformed escape to the home rather than throwing", () => {
    expect(normalizeStorefrontHref("/storefront/products/%E0%A4%A", links)).toBe("/storefront");
  });

  it("sends a deep-link-shaped but dead URL to the home (extra segment / missing handle)", () => {
    expect(normalizeStorefrontHref("/storefront/products/kettle/reviews", links)).toBe("/storefront");
    expect(normalizeStorefrontHref("/storefront/collections", links)).toBe("/storefront");
  });
});
