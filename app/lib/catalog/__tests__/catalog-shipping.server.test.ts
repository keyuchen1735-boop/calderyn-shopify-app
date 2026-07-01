import { describe, it, expect, vi } from "vitest";
const upserts: Record<string, unknown[]> = {};
vi.mock("../project-sku-dim.server", () => ({ projectProductToSkuDim: vi.fn() }));
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    from: (t: string) => ({
      insert: (rows: unknown) => { (upserts[t] ??= []).push(rows); return { select: () => ({ single: () => Promise.resolve({ data: { id: t === "product_dim" ? "p1" : "v1" }, error: null }) }) }; },
      upsert: (rows: unknown) => { (upserts[t] ??= []).push(rows); return Promise.resolve({ error: null }); },
    }),
  }),
}));
describe("createProduct shipping", () => {
  it("writes a variant_shipping row", async () => {
    const { createProduct } = await import("../catalog.server");
    await createProduct("shop1", { title: "Mug", status: "draft", variants: [{ sku: "M", weightGrams: 340, lengthMm: 127, widthMm: 127, heightMm: 102 }] } as never);
    expect(JSON.stringify(upserts["variant_shipping"])).toContain("340");
  });
});
