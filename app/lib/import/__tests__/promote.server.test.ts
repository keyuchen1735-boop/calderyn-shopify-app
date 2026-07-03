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
  const counts = { products: 5, variants: 12, collections: 2, balances: 12 };

  it("names what was imported and always names the exclusions", async () => {
    const { buildImportReport } = await import("../promote.server");
    // customers blocked here → they stay in notIncluded (the exclusion copy under test).
    const r = buildImportReport(counts, 1100, { imported: 0, skipped: 0, blocked: true });
    expect(r.imported.join(" ")).toMatch(/5 products/);
    expect(r.imported.join(" ")).toMatch(/1100 past orders/);
    // balances are stock RECORDS (variant x location), not locations — the copy
    // must never call them locations (12 records here vs 2 locations would lie).
    expect(r.imported.join(" ")).toMatch(/12 stock records/);
    expect(r.imported.join(" ")).not.toMatch(/stock locations/);
    expect(r.notIncluded.join(" ")).toMatch(/customer/i);
    expect(r.notIncluded.join(" ")).toMatch(/store design|theme/i);
  });

  it("reports imported customers with the skipped count", async () => {
    const { buildImportReport } = await import("../promote.server");
    const report = buildImportReport(counts, 12, { imported: 40, skipped: 2, blocked: false });
    expect(report.imported).toContain("40 customers (2 skipped — no email address)");
    expect(report.notIncluded.join(" ")).not.toContain("customer");
  });

  it("keeps customers in notIncluded — with the real reason — when blocked", async () => {
    const { buildImportReport } = await import("../promote.server");
    const report = buildImportReport(counts, 12, { imported: 0, skipped: 0, blocked: true });
    expect(report.notIncluded.join(" ")).toContain("customer");
    expect(report.notIncluded.join(" ")).toContain("access");
  });
});
