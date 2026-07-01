import { describe, it, expect, vi } from "vitest";

const rpc = vi.fn();
vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => ({ rpc }) }));

describe("promoteShopFromMirror", () => {
  it("calls the SQL function and returns its counts", async () => {
    rpc.mockResolvedValue({ data: { products: 5, variants: 12, collections: 2, balances: 12 }, error: null });
    const { promoteShopFromMirror } = await import("../promote.server");
    expect(await promoteShopFromMirror("shop1")).toEqual({ products: 5, variants: 12, collections: 2, balances: 12 });
    expect(rpc).toHaveBeenCalledWith("promote_shop_from_mirror", { p_shop_id: "shop1" });
  });

  it("throws when the SQL function errors", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    const { promoteShopFromMirror } = await import("../promote.server");
    await expect(promoteShopFromMirror("shop1")).rejects.toThrow();
  });
});

describe("buildImportReport", () => {
  it("names what was imported and always names the exclusions", async () => {
    const { buildImportReport } = await import("../promote.server");
    const r = buildImportReport({ products: 5, variants: 12, collections: 2, balances: 12 }, 1100);
    expect(r.imported.join(" ")).toMatch(/5 products/);
    expect(r.imported.join(" ")).toMatch(/1100 past orders/);
    expect(r.notIncluded.join(" ")).toMatch(/customer/i);
    expect(r.notIncluded.join(" ")).toMatch(/store design|theme/i);
  });
});
