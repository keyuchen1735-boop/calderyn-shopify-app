// app/lib/storegen/imagery/asset.server.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StoreProduct } from "~/lib/storefront/catalog";
import { enhanceListing, applyAssetOverrides } from "./asset.server";

const { fromMock, providerMock } = vi.hoisted(() => ({ fromMock: vi.fn(), providerMock: vi.fn() }));
vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => ({ from: fromMock }) }));
vi.mock("./provider.server", () => ({ getImageProvider: () => ({ name: "fake", generateListingImage: providerMock }) }));

const realShop = "11111111-1111-1111-1111-111111111111";
const product = (id: string, url: string | null): StoreProduct => ({
  id, handle: `h-${id}`, title: `P${id}`, description: "", collections: [],
  images: url ? [{ url, alt: null }] : [], variants: [],
});
beforeEach(() => { fromMock.mockReset(); providerMock.mockReset(); });

describe("enhanceListing", () => {
  it("generates an image and upserts a ready asset", async () => {
    providerMock.mockResolvedValue({ url: "https://img/new.png" });
    const upsert = vi.fn().mockResolvedValue({ error: null });
    fromMock.mockReturnValue({ upsert });
    const out = await enhanceListing(realShop, product("1", null));
    expect(out.status).toBe("ready");
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ shop_id: realShop, product_id: "1", url: "https://img/new.png", status: "ready" }), { onConflict: "shop_id,product_id,source" });
  });
  it("on provider failure records a failed asset and keeps the source image (rule 12)", async () => {
    providerMock.mockRejectedValue(new Error("higgs down"));
    const upsert = vi.fn().mockResolvedValue({ error: null });
    fromMock.mockReturnValue({ upsert });
    const out = await enhanceListing(realShop, product("1", "/src.jpg"));
    expect(out.status).toBe("failed");
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }), expect.anything());
  });
});

describe("applyAssetOverrides", () => {
  it("replaces a product's first image with the ready generated asset", async () => {
    const eq = vi.fn().mockResolvedValue({ data: [{ product_id: "1", url: "https://img/new.png", status: "ready" }], error: null });
    fromMock.mockReturnValue({ select: () => ({ eq }) });
    const out = await applyAssetOverrides(realShop, [product("1", "/old.jpg"), product("2", "/keep.jpg")]);
    expect(out[0].images[0].url).toBe("https://img/new.png");
    expect(out[1].images[0].url).toBe("/keep.jpg");
  });
  it("returns products unchanged for a non-uuid (demo) shop without hitting the DB", async () => {
    const out = await applyAssetOverrides("demo-shop", [product("1", "/old.jpg")]);
    expect(out[0].images[0].url).toBe("/old.jpg");
    expect(fromMock).not.toHaveBeenCalled();
  });
  it("adds the override image to a product that had no image (alt falls back to title)", async () => {
    const eq = vi.fn().mockResolvedValue({ data: [{ product_id: "1", url: "https://img/new.png", status: "ready" }], error: null });
    fromMock.mockReturnValue({ select: () => ({ eq }) });
    const out = await applyAssetOverrides(realShop, [product("1", null)]);
    expect(out[0].images).toEqual([{ url: "https://img/new.png", alt: "P1" }]);
  });
});
