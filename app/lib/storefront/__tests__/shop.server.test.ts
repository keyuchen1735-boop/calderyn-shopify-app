// app/lib/storefront/__tests__/shop.server.test.ts
import { describe, it, expect } from "vitest";
import { storefrontSlug, resolveStorefrontShop, DEMO_SHOP_ID } from "../shop.server";

describe("storefrontSlug", () => {
  it("derives the slug from the host subdomain", () => {
    expect(storefrontSlug(new Request("https://acme.calderyncompany.com/storefront"))).toBe("acme");
  });

  it("prefers the ?shop= dev fallback over the host, lowercased", () => {
    expect(storefrontSlug(new Request("https://other.example.com/storefront?shop=Acme"))).toBe("acme");
  });

  it("strips a port from the host", () => {
    expect(storefrontSlug(new Request("http://localhost:3000/storefront"))).toBe("localhost");
  });
});

describe("resolveStorefrontShop", () => {
  it("resolves a storefront request to the single demo tenant for the fixture pilot", async () => {
    expect(await resolveStorefrontShop(new Request("https://acme.calderyncompany.com/storefront"))).toBe(
      DEMO_SHOP_ID,
    );
    expect(await resolveStorefrontShop(new Request("http://localhost:3000/storefront?shop=demo"))).toBe(
      DEMO_SHOP_ID,
    );
  });
});
