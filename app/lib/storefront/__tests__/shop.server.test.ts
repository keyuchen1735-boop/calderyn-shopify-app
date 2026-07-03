// app/lib/storefront/__tests__/shop.server.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  storefrontSlug,
  resolveStorefrontShop,
  resolveTenantShopId,
  clearStorefrontShopCache,
  DEMO_SHOP_ID,
} from "../shop.server";

const { fromMock } = vi.hoisted(() => ({ fromMock: vi.fn() }));
vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => ({ from: fromMock }) }));

const realShop = "11111111-1111-1111-1111-111111111111";

interface ShopRow {
  id: string;
  org_slug: string | null;
  shop_domain?: string;
}

/** The shops lookup chain: .select().or(filter).is("uninstalled_at", null).limit(2). */
function shopsTable(rows: ShopRow[], error: Error | null = null) {
  return {
    select: () => ({
      or: (filter: string) => ({
        is: (col: string, val: unknown) => {
          if (col !== "uninstalled_at" || val !== null) {
            throw new Error(`unexpected is() filter: ${col}=${String(val)}`);
          }
          return {
            limit: async () => {
              if (error) return { data: null, error };
              // Emulate the or() filter: org_slug.eq.X,shop_domain.eq.X.myshopify.com.
              const parts = filter.split(",");
              if (parts.length !== 2) {
                throw new Error(`or() filter shape changed, update this mock: ${filter}`);
              }
              const slug = parts[0].replace("org_slug.eq.", "");
              const domain = parts[1].replace("shop_domain.eq.", "");
              const data = rows.filter((r) => r.org_slug === slug || r.shop_domain === domain);
              return { data, error: null };
            },
          };
        },
      }),
    }),
  };
}

beforeEach(() => {
  fromMock.mockReset();
  clearStorefrontShopCache();
});

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

describe("resolveTenantShopId", () => {
  it("is null for fixture/platform hosts without touching the DB", async () => {
    for (const host of [
      "https://app.calderyncompany.com/",
      "https://www.calderyncompany.com/",
      "http://localhost:3000/",
    ]) {
      expect(await resolveTenantShopId(new Request(host))).toBeNull();
    }
    expect(fromMock).not.toHaveBeenCalled();
  });

  it("is null for a slug that matches no live shop", async () => {
    fromMock.mockReturnValue(shopsTable([]));
    expect(
      await resolveTenantShopId(new Request("https://shopify-9abc123de.vercel.app/")),
    ).toBeNull();
  });

  it("returns the shop id for a real tenant host", async () => {
    fromMock.mockReturnValue(shopsTable([{ id: realShop, org_slug: "acme" }]));
    expect(await resolveTenantShopId(new Request("https://acme.calderyncompany.com/"))).toBe(
      realShop,
    );
  });
});

describe("resolveStorefrontShop", () => {
  it("keeps fixture slugs (demo, app, www, localhost) on the demo tenant without touching the DB", async () => {
    for (const host of [
      "https://demo.calderyncompany.com/storefront",
      "https://app.calderyncompany.com/storefront",
      "https://www.calderyncompany.com/storefront",
      "http://localhost:3000/storefront",
    ]) {
      expect(await resolveStorefrontShop(new Request(host))).toBe(DEMO_SHOP_ID);
    }
    expect(fromMock).not.toHaveBeenCalled();
  });

  it("never treats Object.prototype members as fixture slugs", async () => {
    fromMock.mockReturnValue(shopsTable([]));
    for (const slug of ["constructor", "hasownproperty", "toString".toLowerCase()]) {
      expect(
        await resolveStorefrontShop(new Request(`http://localhost:3000/storefront?shop=${slug}`)),
      ).toBe(DEMO_SHOP_ID);
    }
  });

  it("resolves a native shop by org_slug", async () => {
    fromMock.mockReturnValue(shopsTable([{ id: realShop, org_slug: "acme" }]));
    expect(await resolveStorefrontShop(new Request("https://acme.calderyncompany.com/storefront"))).toBe(
      realShop,
    );
  });

  it("resolves a Shopify-origin shop by its myshopify domain", async () => {
    fromMock.mockReturnValue(
      shopsTable([{ id: realShop, org_slug: null, shop_domain: "acme-2.myshopify.com" }]),
    );
    expect(await resolveStorefrontShop(new Request("http://localhost:3000/storefront?shop=acme-2"))).toBe(
      realShop,
    );
  });

  it("prefers the org_slug owner when both identities match the slug", async () => {
    const other = "22222222-2222-2222-2222-222222222222";
    fromMock.mockReturnValue(
      shopsTable([
        { id: other, org_slug: null, shop_domain: "acme.myshopify.com" },
        { id: realShop, org_slug: "acme" },
      ]),
    );
    expect(await resolveStorefrontShop(new Request("https://acme.calderyncompany.com/storefront"))).toBe(
      realShop,
    );
  });

  it("caches a resolution so repeat requests inside the TTL skip the DB", async () => {
    fromMock.mockReturnValue(shopsTable([{ id: realShop, org_slug: "acme" }]));
    const req = () => new Request("https://acme.calderyncompany.com/storefront");
    await resolveStorefrontShop(req());
    fromMock.mockClear();
    expect(await resolveStorefrontShop(req())).toBe(realShop);
    expect(fromMock).not.toHaveBeenCalled();
  });

  it("caches a miss so unknown-slug traffic cannot hammer the DB", async () => {
    fromMock.mockReturnValue(shopsTable([]));
    const req = () => new Request("https://nobody.calderyncompany.com/storefront");
    expect(await resolveStorefrontShop(req())).toBe(DEMO_SHOP_ID);
    fromMock.mockClear();
    expect(await resolveStorefrontShop(req())).toBe(DEMO_SHOP_ID);
    expect(fromMock).not.toHaveBeenCalled();
  });

  it("rejects a non-hostlabel slug without touching the DB", async () => {
    expect(
      await resolveStorefrontShop(new Request("http://localhost:3000/storefront?shop=a.b%2Cor")),
    ).toBe(DEMO_SHOP_ID);
    expect(fromMock).not.toHaveBeenCalled();
  });

  it("propagates a DB error instead of masking it as the demo shell", async () => {
    fromMock.mockReturnValue(shopsTable([], new Error("db down")));
    await expect(
      resolveStorefrontShop(new Request("https://erroring.calderyncompany.com/storefront")),
    ).rejects.toThrow("db down");
  });
});
