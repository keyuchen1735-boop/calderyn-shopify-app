import { describe, it, expect, vi } from "vitest";

describe("getAgenticCatalog", () => {
  it("maps v_agentic_catalog rows to feed items in cents", async () => {
    vi.resetModules();
    // v_agentic_catalog exposes a SINGLE `sku_title` (sku_dim has one `title` column, no
    // product/variant split) and `variant_id` (aliased from sku_dim.external_id).
    const rows = [{ variant_id: "V1", sku_title: "Widget - Large", retail_price_cents: 1999, currency: "usd", on_hand: 5, vendor: "Acme", category: "tools", tags: ["a"] }];
    vi.doMock("~/lib/supabase.server", () => ({
      getSupabase: () => ({ from: () => ({ select: () => ({ eq: async () => ({ data: rows, error: null }) }) }) }),
    }));
    const { getAgenticCatalog } = await import("./catalog.server");
    const feed = await getAgenticCatalog("shop_test");
    expect(feed[0]).toMatchObject({ variantId: "V1", priceCents: 1999, availableQty: 5, title: "Widget - Large" });
  });
});
