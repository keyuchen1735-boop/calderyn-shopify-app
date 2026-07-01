import { describe, it, expect, vi } from "vitest";

describe("getShopOrigin", () => {
  it("throws ORIGIN_NOT_CONFIGURED when no stored origin and Shopify address is incomplete", async () => {
    vi.resetModules();
    vi.doMock("~/lib/supabase.server", () => ({
      getSupabase: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) }),
    }));
    vi.doMock("./shopify-shop-address.server", () => ({ fetchShopifyShopAddress: async () => null }));
    const { getShopOrigin } = await import("./origin.server");
    await expect(getShopOrigin("shop_test")).rejects.toMatchObject({ code: "ORIGIN_NOT_CONFIGURED" });
  });

  it("returns the stored origin when present (no Shopify call)", async () => {
    vi.resetModules();
    const row = { street1: "1 A St", city: "Denver", state: "CO", zip: "80202", country: "US" };
    vi.doMock("~/lib/supabase.server", () => ({
      getSupabase: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }) }) }),
    }));
    const { getShopOrigin } = await import("./origin.server");
    const origin = await getShopOrigin("shop_test");
    expect(origin.zip).toBe("80202");
  });
});
