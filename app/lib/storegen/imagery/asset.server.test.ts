// app/lib/storegen/imagery/asset.server.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StoreProduct } from "~/lib/storefront/catalog";
import { enhanceListing, applyAssetOverrides } from "./asset.server";

const { fromMock, providerMock, persistMock } = vi.hoisted(() => ({ fromMock: vi.fn(), providerMock: vi.fn(), persistMock: vi.fn() }));
vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => ({ from: fromMock }) }));
vi.mock("./provider.server", () => ({ getImageProvider: () => ({ name: "fake", generateListingImage: providerMock }) }));
vi.mock("~/lib/assets/persist.server", () => ({ persistExternalImage: persistMock }));

const realShop = "11111111-1111-1111-1111-111111111111";
const product = (id: string, url: string | null): StoreProduct => ({
  id, handle: `h-${id}`, title: `P${id}`, description: "", collections: [],
  images: url ? [{ url, alt: null }] : [], variants: [],
});
beforeEach(() => { fromMock.mockReset(); providerMock.mockReset(); persistMock.mockReset(); });

type AssetRow = Record<string, unknown>;
type AssetQuery = {
  eq: ReturnType<typeof vi.fn>;
  in: ReturnType<typeof vi.fn>;
  order: ReturnType<typeof vi.fn>;
  range: ReturnType<typeof vi.fn>;
};

function mockAssetQueries(pagesByQuery: AssetRow[][][]): AssetQuery[] {
  const queries: AssetQuery[] = [];
  fromMock.mockImplementation(() => {
    const pages = pagesByQuery[queries.length] ?? [[]];
    const query: AssetQuery = {
      eq: vi.fn(),
      in: vi.fn(),
      order: vi.fn(),
      range: vi.fn(),
    };
    query.eq.mockReturnValue(query);
    query.in.mockReturnValue(query);
    query.order.mockReturnValue(query);
    query.range.mockImplementation(async () => ({ data: pages[0] ?? [], error: null }));
    queries.push(query);
    return { select: () => query };
  });
  return queries;
}

describe("enhanceListing", () => {
  it("persists the ephemeral generated image and upserts the OWNED url (rule 12: durable)", async () => {
    providerMock.mockResolvedValue({ url: "data:image/png;base64,aW1hZ2U=" });
    persistMock.mockResolvedValue({ persisted: true, url: "https://owned.cdn/a.png", assetId: "a1", storageKey: "k" });
    const upsert = vi.fn().mockResolvedValue({ error: null });
    fromMock.mockReturnValue({ upsert });
    const signal = new AbortController().signal;
    const out = await enhanceListing(realShop, product("1", null), { signal });
    expect(providerMock).toHaveBeenCalledWith(expect.objectContaining({ signal }));
    expect(persistMock).toHaveBeenCalledWith(realShop, "data:image/png;base64,aW1hZ2U=", "generated", "generated", { signal });
    expect(out.status).toBe("ready");
    expect(out.url).toBe("https://owned.cdn/a.png");
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ shop_id: realShop, product_id: "1", url: "https://owned.cdn/a.png", status: "ready" }), { onConflict: "shop_id,product_id,source", ignoreDuplicates: false });
  });
  it("fails closed when Gemini inline-image persistence fails", async () => {
    providerMock.mockResolvedValue({ url: "data:image/png;base64,aW1hZ2U=" });
    persistMock.mockResolvedValue({ persisted: false, url: "data:image/png;base64,aW1hZ2U=", error: "fetch_failed" });
    const upsert = vi.fn().mockResolvedValue({ error: null });
    fromMock.mockReturnValue({ upsert });
    const out = await enhanceListing(realShop, product("1", null));
    expect(out.status).toBe("failed");
    expect(out.url).toBeNull();
  });
  it("on provider failure records a failed asset and keeps the source image (rule 12)", async () => {
    providerMock.mockRejectedValue(new Error("gemini down"));
    const upsert = vi.fn().mockResolvedValue({ error: null });
    fromMock.mockReturnValue({ upsert });
    const out = await enhanceListing(realShop, product("1", "/src.jpg"));
    expect(out.status).toBe("failed");
    expect(persistMock).not.toHaveBeenCalled();
    // A failed attempt must not overwrite a previously-ready asset: it inserts
    // only when no row exists yet (ignoreDuplicates), never downgrading a good image.
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }), { onConflict: "shop_id,product_id,source", ignoreDuplicates: true });
  });
  it("does not write an asset after the first-preview imagery deadline", async () => {
    const controller = new AbortController();
    providerMock.mockResolvedValue({ url: "data:image/png;base64,aW1hZ2U=" });
    persistMock.mockImplementation(async () => {
      controller.abort();
      return { persisted: false, url: "data:image/png;base64,aW1hZ2U=", error: "cancelled" };
    });
    const out = await enhanceListing(realShop, product("1", null), { signal: controller.signal });
    expect(out.status).toBe("failed");
    expect(fromMock).not.toHaveBeenCalled();
  });
});

describe("applyAssetOverrides", () => {
  it("keeps real product_media ahead of ready generated imagery", async () => {
    mockAssetQueries([[[{ product_id: "1", url: "https://img/new.png", status: "ready" }]]]);
    const out = await applyAssetOverrides(realShop, [product("1", "/old.jpg"), product("2", "/keep.jpg")]);
    expect(out[0].images[0].url).toBe("/old.jpg");
    expect(out[1].images[0].url).toBe("/keep.jpg");
  });
  it("returns products unchanged for a non-uuid (demo) shop without hitting the DB", async () => {
    const out = await applyAssetOverrides("demo-shop", [product("1", "/old.jpg")]);
    expect(out[0].images[0].url).toBe("/old.jpg");
    expect(fromMock).not.toHaveBeenCalled();
  });
  it("adds the override image to a product that had no image (alt falls back to title)", async () => {
    mockAssetQueries([[[{ product_id: "1", url: "https://img/new.png", status: "ready" }]]]);
    const out = await applyAssetOverrides(realShop, [product("1", null)]);
    expect(out[0].images).toEqual([{ url: "https://img/new.png", alt: "P1" }]);
  });
  it("never renders pending or failed generated imagery", async () => {
    mockAssetQueries([[[
      { product_id: "1", url: "https://img/pending.png", status: "pending" },
      { product_id: "2", url: "https://img/failed.png", status: "failed" },
    ]]]);
    const out = await applyAssetOverrides(realShop, [product("1", null), product("2", null)]);
    expect(out.map((entry) => entry.images)).toEqual([[], []]);
  });
  it("prefers the newest ready generated asset when legacy rows remain", async () => {
    mockAssetQueries([[[
      { product_id: "1", url: "https://img/old.png", status: "ready", created_at: "2026-01-01" },
      { product_id: "1", url: "https://img/new.png", status: "ready", created_at: "2026-07-14" },
    ]]]);
    const out = await applyAssetOverrides(realShop, [product("1", null)]);
    expect(out[0].images[0].url).toBe("https://img/new.png");
  });
  it("queries only ready assets for current image-less product IDs in bounded chunks", async () => {
    const queries = mockAssetQueries([[[]], [[]]]);
    const missing = Array.from({ length: 101 }, (_, index) => product(String(index), null));
    await applyAssetOverrides(realShop, [...missing, product("has-media", "/real.jpg")]);

    expect(queries).toHaveLength(2);
    expect(queries[0].eq.mock.calls).toEqual([
      ["shop_id", realShop],
      ["status", "ready"],
    ]);
    expect(queries[0].in).toHaveBeenCalledWith("product_id", missing.slice(0, 100).map((entry) => entry.id));
    expect(queries[1].in).toHaveBeenCalledWith("product_id", ["100"]);
    expect(queries.flatMap((query) => query.in.mock.calls[0][1] as string[])).not.toContain("has-media");
  });
  it("pages through a full PostgREST response before choosing the newest ready asset", async () => {
    const firstPage = Array.from({ length: 1000 }, (_, index) => ({
      product_id: "1",
      source: `legacy-${index}`,
      url: `https://img/old-${index}.png`,
      status: "ready",
      created_at: "2026-01-01",
    }));
    const secondPage = [{
      product_id: "1",
      source: "gemini",
      url: "https://img/new.png",
      status: "ready",
      created_at: "2026-07-16",
    }];
    const queries = mockAssetQueries([[firstPage], [secondPage]]);

    const out = await applyAssetOverrides(realShop, [product("1", null)]);

    expect(queries.flatMap((query) => query.range.mock.calls)).toEqual([[0, 999], [1000, 1999]]);
    expect(out[0].images[0].url).toBe("https://img/new.png");
  });
});
