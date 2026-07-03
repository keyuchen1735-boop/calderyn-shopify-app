import { describe, it, expect, vi } from "vitest";

const rpc = vi.fn();
vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => ({ rpc }) }));

const FULL_COUNTS = {
  products: 5,
  variants: 12,
  collections: 2,
  balances: 12,
  orders: 1100,
  refunds: 30,
};

describe("promoteShopFromMirror", () => {
  it("calls the SQL function and returns its counts", async () => {
    rpc.mockResolvedValue({ data: FULL_COUNTS, error: null });
    const { promoteShopFromMirror } = await import("../promote.server");
    expect(await promoteShopFromMirror("shop1")).toEqual(FULL_COUNTS);
    expect(rpc).toHaveBeenCalledWith("promote_shop_from_mirror", { p_shop_id: "shop1" });
  });

  it("throws when the SQL function errors", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    const { promoteShopFromMirror } = await import("../promote.server");
    await expect(promoteShopFromMirror("shop1")).rejects.toThrow();
  });
});

describe("buildImportReport", () => {
  const counts = { ...FULL_COUNTS };

  it("names what was imported (order + refund history from the promote) and the exclusions", async () => {
    const { buildImportReport } = await import("../promote.server");
    // customers blocked here → they stay in notIncluded (the exclusion copy under test).
    const r = buildImportReport(counts, { imported: 0, skipped: 0, blocked: true });
    expect(r.imported.join(" ")).toMatch(/5 products/);
    // The order count is the PROMOTED count (imported_order rows), not a raw pull count.
    expect(r.imported.join(" ")).toMatch(/1100 past orders/);
    expect(r.imported.join(" ")).toMatch(/30 past refunds/);
    // balances are stock RECORDS (variant x location), not locations — the copy
    // must never call them locations (12 records here vs 2 locations would lie).
    expect(r.imported.join(" ")).toMatch(/12 stock records/);
    expect(r.imported.join(" ")).not.toMatch(/stock locations/);
    expect(r.notIncluded.join(" ")).toMatch(/customer/i);
    expect(r.notIncluded.join(" ")).toMatch(/store design|theme/i);
  });

  it("omits the refunds line when there are no refunds (never a '0 refunds' lie)", async () => {
    const { buildImportReport } = await import("../promote.server");
    const r = buildImportReport({ ...counts, refunds: 0 }, { imported: 0, skipped: 0, blocked: true });
    expect(r.imported.join(" ")).not.toMatch(/refund/i);
  });

  it("reports imported customers with the skipped count", async () => {
    const { buildImportReport } = await import("../promote.server");
    const report = buildImportReport(counts, { imported: 40, skipped: 2, blocked: false });
    expect(report.imported).toContain("40 customers (2 skipped — no email address)");
    expect(report.notIncluded.join(" ")).not.toContain("customer");
  });

  it("keeps customers in notIncluded — with the real reason — when blocked", async () => {
    const { buildImportReport } = await import("../promote.server");
    const report = buildImportReport(counts, { imported: 0, skipped: 0, blocked: true });
    expect(report.notIncluded.join(" ")).toContain("customer");
    expect(report.notIncluded.join(" ")).toContain("access");
  });
});
