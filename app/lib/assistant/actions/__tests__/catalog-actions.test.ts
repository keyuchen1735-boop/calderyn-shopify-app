import { beforeEach, describe, expect, it, vi } from "vitest";

// Mocks must be defined before importing the module under test
vi.mock("../../../catalog/catalog.server", () => ({
  createProduct: vi.fn(async () => ({ id: "prod-1" })),
  setProductStatus: vi.fn(async () => undefined),
  setVariantPrice: vi.fn(async () => ({ priorPriceCents: 1000 })),
  createCollection: vi.fn(async () => ({ id: "col-1" })),
  getProduct: vi.fn(async () => ({ title: "Blue Hoodie" })),
}));

vi.mock("../../../calderyn.server", () => ({
  calderynClient: () => ({ guardrails: { get: async () => ({ max_price_change_pct: 20 }) } }),
}));

const updateLocationDetails = vi.fn(async () => undefined);

vi.mock("../../../catalog/locations.server", () => ({
  updateLocationDetails: (...a: unknown[]) => updateLocationDetails(...(a as [])),
}));

vi.mock("../../../supabase.server", () => ({
  getSupabase: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: { retail_price_cents: 1000 }, error: null }),
          }),
        }),
      }),
    }),
  }),
}));

// eslint-disable-next-line import/first -- import must follow vi.mock setup
import { CATALOG_ACTIONS } from "../catalog-actions.server";
// eslint-disable-next-line import/first -- import must follow vi.mock setup
import { createProduct, setProductStatus, setVariantPrice, createCollection } from "../../../catalog/catalog.server";
// eslint-disable-next-line import/first -- import must follow vi.mock setup
type OkV = { ok: true; value: Record<string, unknown> };

const byName = (n: string) => CATALOG_ACTIONS.find((a) => a.name === n)!;
const ctx = { shopId: "shop-1", conversationId: "conv-1", idempotencyKey: "ik-1" };

describe("catalog actions", () => {
  beforeEach(() => {
    vi.mocked(createProduct).mockClear();
    vi.mocked(setProductStatus).mockClear();
    vi.mocked(setVariantPrice).mockClear();
    vi.mocked(createCollection).mockClear();
    updateLocationDetails.mockClear();
  });

  it("keeps catalog actions but exposes no second storefront writer", () => {
    expect(CATALOG_ACTIONS.map(({ name }) => name)).not.toEqual(expect.arrayContaining([
      "save_hero_copy",
      "save_accent_color",
      "save_vibe",
      "publish_store",
      "start_experiment",
      "decide_experiment",
      "ship_experiment",
    ]));
    expect(byName("create_product")).toBeTruthy();
    expect(byName("create_collection")).toBeTruthy();
  });

  it("create_product builds a draft ProductInput with one variant at price_cents", async () => {
    const a = byName("create_product");
    const v = a.validate({ title: "Blue Hoodie", price_cents: 3900, description: "Cozy" });
    expect(v.ok).toBe(true);
    await a.run(ctx, (v as OkV).value);
    expect(createProduct).toHaveBeenCalledWith(
      "shop-1",
      expect.objectContaining({
        title: "Blue Hoodie",
        status: "draft",
        variants: [expect.objectContaining({ retailPriceCents: 3900 })],
      }),
    );
  });

  it("create_product validates unknown properties (e.g. status) but ignores them", () => {
    const a = byName("create_product");
    // Try to pass status in the input — validate should accept it but ignore it
    const v = a.validate({ title: "Blue Hoodie", price_cents: 3900, status: "active" });
    expect(v.ok).toBe(true);
    // Verify the validated value does NOT have status
    expect((v as OkV).value).not.toHaveProperty("status");
  });

  it("create_product always creates with draft status regardless of input", async () => {
    const a = byName("create_product");
    // Even if someone tried to force status in the input, run always uses draft
    const v = a.validate({ title: "Test", price_cents: 1000, status: "active" as unknown });
    expect(v.ok).toBe(true);
    await a.run(ctx, (v as OkV).value);
    // Verify createProduct was called with status: "draft"
    expect(createProduct).toHaveBeenCalledWith(
      "shop-1",
      expect.objectContaining({
        status: "draft",
      }),
    );
  });

  it("create_product rejects a title over 200 chars", () => {
    const a = byName("create_product");
    expect(a.validate({ title: "x".repeat(201), price_cents: 100 }).ok).toBe(false);
  });

  it("create_product rejects a non-positive price_cents", () => {
    const a = byName("create_product");
    expect(a.validate({ title: "Hat", price_cents: 0 }).ok).toBe(false);
  });

  it("set_product_status only accepts active|draft (archived goes through archive_product)", () => {
    const a = byName("set_product_status");
    expect(a.validate({ product_id: "p1", status: "archived" }).ok).toBe(false);
    expect(a.validate({ product_id: "p1", status: "active" }).ok).toBe(true);
  });

  it("set_product_status calls setProductStatus with the validated status", async () => {
    const a = byName("set_product_status");
    const v = a.validate({ product_id: "p1", status: "active" });
    expect(v.ok).toBe(true);
    await a.run(ctx, (v as OkV).value);
    expect(setProductStatus).toHaveBeenCalledWith("shop-1", "p1", "active");
  });

  it("archive_product is confirm-tier", () => {
    const a = byName("archive_product");
    expect(a.tier).toBe("confirm");
    expect(a.undoable).toBe(false);
  });

  it("archive_product calls setProductStatus with archived", async () => {
    const a = byName("archive_product");
    const v = a.validate({ product_id: "p1" });
    expect(v.ok).toBe(true);
    await a.run(ctx, (v as OkV).value);
    expect(setProductStatus).toHaveBeenCalledWith("shop-1", "p1", "archived");
  });

  it("set_variant_price enforces the shop's max_price_change_pct against the prior price", async () => {
    const a = byName("set_variant_price");
    await expect(a.run(ctx, { variant_id: "v1", price_cents: 5000 })).rejects.toThrow(/max_price_change_pct|20%/i);
    await expect(a.run(ctx, { variant_id: "v1", price_cents: 1100 })).resolves.toMatchObject({
      detail: { prior_price_cents: 1000 },
    });
  });

  it("create_collection requires a title (max 120 chars)", () => {
    const a = byName("create_collection");
    expect(a.validate({ title: "" }).ok).toBe(false);
    expect(a.validate({ title: "x".repeat(121) }).ok).toBe(false);
    expect(a.validate({ title: "Summer" }).ok).toBe(true);
  });

  it("create_collection calls createCollection", async () => {
    const a = byName("create_collection");
    const v = a.validate({ title: "Summer" });
    expect(v.ok).toBe(true);
    await a.run(ctx, (v as OkV).value);
    expect(createCollection).toHaveBeenCalledWith("shop-1", "Summer");
  });

  describe("set_location_details", () => {
    it("requires location_id", () => {
      const a = byName("set_location_details");
      expect(a.validate({ priority: 1 }).ok).toBe(false);
      expect(a.validate({ location_id: "loc-1" }).ok).toBe(false);
    });

    it("rejects when no patch field is present besides location_id", () => {
      const a = byName("set_location_details");
      const v = a.validate({ location_id: "loc-1" });
      expect(v.ok).toBe(false);
    });

    it("builds a partial LocationPatch from only the present fields", () => {
      const a = byName("set_location_details");
      const v = a.validate({ location_id: "loc-1", city: "Austin", priority: 2 });
      expect(v.ok).toBe(true);
      expect((v as OkV).value).toEqual({ location_id: "loc-1", patch: { city: "Austin", priority: 2 } });
    });

    it("accepts lat/lng as null (to clear them)", () => {
      const a = byName("set_location_details");
      const v = a.validate({ location_id: "loc-1", lat: null, lng: null });
      expect(v.ok).toBe(true);
      expect((v as OkV).value).toEqual({ location_id: "loc-1", patch: { lat: null, lng: null } });
    });

    it("calls updateLocationDetails(sb, shopId, locationId, patch)", async () => {
      const a = byName("set_location_details");
      const v = a.validate({ location_id: "loc-1", city: "Austin" });
      expect(v.ok).toBe(true);
      const r = await a.run(ctx, (v as OkV).value);
      expect(updateLocationDetails).toHaveBeenCalledWith(expect.anything(), "shop-1", "loc-1", { city: "Austin" });
      expect(r.summary).toBe("Updated the location");
    });

    it("is execute-tier, not undoable", () => {
      const a = byName("set_location_details");
      expect(a.tier).toBe("execute");
      expect(a.undoable).toBe(false);
    });
  });

});
