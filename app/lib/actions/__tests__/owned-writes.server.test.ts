import { describe, it, expect, vi, beforeEach } from "vitest";

const setVariantPrice = vi.fn();
vi.mock("../../catalog/catalog.server", () => ({
  setVariantPrice: (...a: unknown[]) => setVariantPrice(...a),
}));

const createTransfer = vi.fn();
vi.mock("../../inventory/engine.server", () => ({
  createTransfer: (...a: unknown[]) => createTransfer(...a),
}));

// getOwnedVariantPricing reads sku_dim + variant_dim through getSupabase.
let skuRow: Record<string, unknown> | null;
let variantRow: Record<string, unknown> | null;
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    from: (table: string) => {
      const row = table === "sku_dim" ? skuRow : variantRow;
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.maybeSingle = async () => ({ data: row, error: null });
      return chain;
    },
  }),
}));

import {
  getOwnedVariantPricing,
  setOwnedVariantPrice,
  applyOwnedInventoryMove,
} from "../owned-writes.server";

beforeEach(() => {
  vi.clearAllMocks();
  skuRow = { id: "v1" };
  variantRow = { retail_price_cents: 1500 };
});

describe("getOwnedVariantPricing", () => {
  it("resolves the owned variant id + current price for an owned SKU", async () => {
    const r = await getOwnedVariantPricing("shop-1", "SKU-A");
    expect(r).toEqual({ variantId: "v1", currentPriceCents: 1500 });
  });

  it("returns null when the SKU is not owned", async () => {
    skuRow = null;
    expect(await getOwnedVariantPricing("shop-1", "SKU-A")).toBeNull();
  });

  it("returns null when the owned variant has no price", async () => {
    variantRow = { retail_price_cents: null };
    expect(await getOwnedVariantPricing("shop-1", "SKU-A")).toBeNull();
  });
});

describe("setOwnedVariantPrice", () => {
  it("delegates to catalog.setVariantPrice", async () => {
    setVariantPrice.mockResolvedValue({ priorPriceCents: 1500 });
    const r = await setOwnedVariantPrice("shop-1", "v1", 1700);
    expect(setVariantPrice).toHaveBeenCalledWith("shop-1", "v1", 1700);
    expect(r).toEqual({ priorPriceCents: 1500 });
  });
});

describe("applyOwnedInventoryMove", () => {
  it("delegates to the inventory engine as an instant transfer", async () => {
    createTransfer.mockResolvedValue({ transferId: "tr-1" });
    const r = await applyOwnedInventoryMove({
      shopId: "shop-1",
      variantId: "v1",
      fromLocationId: "loc-a",
      toLocationId: "loc-b",
      quantity: 40,
    });
    expect(createTransfer).toHaveBeenCalledWith("shop-1", "v1", "loc-a", "loc-b", 40, "instant");
    expect(r).toEqual({ transferId: "tr-1" });
  });
});
