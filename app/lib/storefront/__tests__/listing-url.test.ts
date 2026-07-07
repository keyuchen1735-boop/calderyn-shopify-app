import { describe, it, expect } from "vitest";

import { storefrontListingUrl } from "../listing-url";

describe("storefrontListingUrl", () => {
  it("uses the tenant's real org_slug verbatim and the /storefront path the subdomain serves", () => {
    // The real slug carries dashes + a unique suffix; it must be used as-is,
    // never re-derived from the display name.
    const url = storefrontListingUrl(
      "harbor-vine-381b4b",
      "Harbor & Vine",
      "Hand-Poured Cedar Sage Soy Candle, 8oz",
    );
    expect(url).toBe(
      "harbor-vine-381b4b.calderyncompany.com/storefront/products/hand-poured-cedar-sage-soy-candle-8oz",
    );
  });

  it("never produces the old broken shape (stripped slug, no /storefront)", () => {
    const url = storefrontListingUrl("harbor-vine-381b4b", "Harbor & Vine", "Tee");
    expect(url).not.toContain("harborvine.calderyncompany.com");
    expect(url).toContain("/storefront/products/");
  });

  it("falls back to a dashed slug from the display name when there is no org_slug", () => {
    expect(storefrontListingUrl(null, "Harbor & Vine", "Tee")).toBe(
      "harbor-vine.calderyncompany.com/storefront/products/tee",
    );
  });
});
