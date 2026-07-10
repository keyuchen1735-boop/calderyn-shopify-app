import { beforeEach, describe, expect, it, vi } from "vitest";

// Mocks must be defined before importing the module under test
vi.mock("../../../catalog/catalog.server", () => ({
  createProduct: vi.fn(async () => ({ id: "prod-1" })),
  setProductStatus: vi.fn(async () => undefined),
  setVariantPrice: vi.fn(async () => ({ priorPriceCents: 1000 })),
  createCollection: vi.fn(async () => ({ id: "col-1" })),
  getProduct: vi.fn(async () => ({ title: "Blue Hoodie" })),
}));

vi.mock("../../../storebuilder/studio.server", () => ({
  saveStudioHero: vi.fn(async (_shopId: string, hero: unknown) => hero),
  saveStudioAccent: vi.fn(async () => undefined),
  saveStudioVibe: vi.fn(async () => undefined),
  publishStudioStore: vi.fn(async () => undefined),
}));

vi.mock("../../../calderyn.server", () => ({
  calderynClient: () => ({ guardrails: { get: async () => ({ max_price_change_pct: 20 }) } }),
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
import { saveStudioHero, saveStudioAccent, saveStudioVibe, publishStudioStore } from "../../../storebuilder/studio.server";

type OkV = { ok: true; value: Record<string, unknown> };

const byName = (n: string) => CATALOG_ACTIONS.find((a) => a.name === n)!;
const ctx = { shopId: "shop-1", conversationId: "conv-1", idempotencyKey: "ik-1" };

describe("catalog actions", () => {
  beforeEach(() => {
    vi.mocked(createProduct).mockClear();
    vi.mocked(setProductStatus).mockClear();
    vi.mocked(setVariantPrice).mockClear();
    vi.mocked(createCollection).mockClear();
    vi.mocked(saveStudioHero).mockClear();
    vi.mocked(saveStudioAccent).mockClear();
    vi.mocked(saveStudioVibe).mockClear();
    vi.mocked(publishStudioStore).mockClear();
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

  it("save_hero_copy requires a headline (max 300 chars)", () => {
    const a = byName("save_hero_copy");
    expect(a.validate({}).ok).toBe(false);
    expect(a.validate({ headline: "x".repeat(301) }).ok).toBe(false);
    expect(a.validate({ headline: "New season" }).ok).toBe(true);
  });

  it("save_hero_copy calls saveStudioHero with headline/subhead", async () => {
    const a = byName("save_hero_copy");
    const v = a.validate({ headline: "New season", subhead: "Shop now" });
    expect(v.ok).toBe(true);
    await a.run(ctx, (v as OkV).value);
    expect(saveStudioHero).toHaveBeenCalledWith("shop-1", { headline: "New season", subhead: "Shop now" });
  });

  it("publish_store is confirm-tier and its summary says it goes live to buyers", async () => {
    const a = byName("publish_store");
    expect(a.tier).toBe("confirm");
    expect(await a.confirmSummary!(ctx, {})).toMatch(/live/i);
  });

  it("publish_store calls publishStudioStore", async () => {
    const a = byName("publish_store");
    await a.run(ctx, {});
    expect(publishStudioStore).toHaveBeenCalledWith("shop-1");
  });

  it("save_accent_color validates #rrggbb", () => {
    const a = byName("save_accent_color");
    expect(a.validate({ color: "tomato" }).ok).toBe(false);
    expect(a.validate({ color: "#AABB07" }).ok).toBe(true);
  });

  it("save_accent_color calls saveStudioAccent", async () => {
    const a = byName("save_accent_color");
    const v = a.validate({ color: "#AABB07" });
    expect(v.ok).toBe(true);
    await a.run(ctx, (v as OkV).value);
    expect(saveStudioAccent).toHaveBeenCalledWith("shop-1", "#AABB07");
  });

  it("save_vibe only accepts minimal|bold|warm", async () => {
    const a = byName("save_vibe");
    expect(a.validate({ vibe: "loud" }).ok).toBe(false);
    const v = a.validate({ vibe: "bold" });
    expect(v.ok).toBe(true);
    await a.run(ctx, (v as OkV).value);
    expect(saveStudioVibe).toHaveBeenCalledWith("shop-1", "bold");
  });
});
