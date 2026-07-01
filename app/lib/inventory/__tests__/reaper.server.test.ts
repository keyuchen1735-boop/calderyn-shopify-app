import { describe, it, expect, vi, beforeEach } from "vitest";
const expiredRows = [{ shop_id: "s1", checkout_ref: "co1" }, { shop_id: "s1", checkout_ref: "co1" }];
const release = vi.fn().mockResolvedValue(undefined);
vi.mock("~/lib/inventory/engine.server", () => ({ releaseReservation: release }));
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({ from: () => ({ select: () => ({ eq: () => ({ lt: () => Promise.resolve({ data: expiredRows, error: null }) }) }) }) }),
}));
beforeEach(() => release.mockClear());

describe("expireStaleReservations", () => {
  it("releases each distinct expired checkout once", async () => {
    const { expireStaleReservations } = await import("../reaper.server");
    const r = await expireStaleReservations();
    expect(release).toHaveBeenCalledTimes(1); // dedupes co1
    expect(r.released).toBe(1);
  });
});
