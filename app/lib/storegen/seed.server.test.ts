// app/lib/storegen/seed.server.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { FALLBACK_SEED } from "./seed";

const createCollectionMock = vi.hoisted(() => vi.fn());
const createProductMock = vi.hoisted(() => vi.fn());
const setStatusMock = vi.hoisted(() => vi.fn());
vi.mock("~/lib/catalog/catalog.server", () => ({
  createCollection: createCollectionMock,
  createProduct: createProductMock,
  setProductStatus: setStatusMock,
}));

const sampleQueryMock = vi.hoisted(() => vi.fn());
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({ from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ contains: sampleQueryMock }) }) }) }) }),
}));

// eslint-disable-next-line import/first -- vitest hoists the vi.mock calls above this import
import { seedSampleCatalog, clearSampleProducts, SAMPLE_TAG } from "./seed.server";

beforeEach(() => {
  createCollectionMock.mockReset().mockImplementation(async (_shop: string, title: string) => ({ id: `col-${title}` }));
  createProductMock.mockReset().mockResolvedValue({ id: "prod-1" });
  setStatusMock.mockReset().mockResolvedValue(undefined);
  sampleQueryMock.mockReset().mockResolvedValue({ data: [{ id: "s1" }, { id: "s2" }], error: null });
});

describe("seedSampleCatalog", () => {
  it("creates every collection then every product with the sample + hint tags", async () => {
    const out = await seedSampleCatalog("shop-1", FALLBACK_SEED);
    expect(out).toEqual({ collections: 2, products: 6, failed: 0 });
    expect(createCollectionMock).toHaveBeenCalledTimes(2);
    const first = createProductMock.mock.calls[0];
    expect(first[0]).toBe("shop-1");
    expect(first[1].status).toBe("active");
    expect(first[1].tags).toEqual([SAMPLE_TAG, "cd-icon:coffee", "cd-tone:warm"]);
    expect(first[1].variants).toEqual([{ retailPriceCents: 2800, inventoryTracked: false }]);
    expect(first[1].collectionIds).toEqual(["col-Featured"]);
  });
  it("continues past a single product failure and reports it (rule 12)", async () => {
    createProductMock.mockRejectedValueOnce(new Error("boom"));
    const out = await seedSampleCatalog("shop-1", FALLBACK_SEED);
    expect(out.products).toBe(5);
    expect(out.failed).toBe(1);
  });
});

describe("clearSampleProducts", () => {
  it("archives every active sample product and returns the count", async () => {
    const n = await clearSampleProducts("shop-1");
    expect(n).toBe(2);
    expect(setStatusMock).toHaveBeenCalledWith("shop-1", "s1", "archived");
    expect(setStatusMock).toHaveBeenCalledWith("shop-1", "s2", "archived");
  });
  it("returns 0 and archives nothing when there are no samples", async () => {
    sampleQueryMock.mockResolvedValue({ data: [], error: null });
    expect(await clearSampleProducts("shop-1")).toBe(0);
    expect(setStatusMock).not.toHaveBeenCalled();
  });
  it("throws if the tag query errors (never silently reports success — rule 12)", async () => {
    sampleQueryMock.mockResolvedValue({ data: null, error: new Error("db down") });
    await expect(clearSampleProducts("shop-1")).rejects.toThrow();
  });
});
