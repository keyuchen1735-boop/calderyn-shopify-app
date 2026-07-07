import { describe, it, expect, vi, beforeEach } from "vitest";
// Mutable so a test can vary the stale rows the reaper sees.
let expiredRows: Array<{ shop_id: string; checkout_ref: string }> = [
  { shop_id: "s1", checkout_ref: "co1" },
  { shop_id: "s1", checkout_ref: "co1" },
];
const release = vi.fn().mockResolvedValue(undefined);
vi.mock("~/lib/inventory/engine.server", () => ({ releaseReservation: release }));
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({ from: () => ({ select: () => ({ eq: () => ({ lt: () => Promise.resolve({ data: expiredRows, error: null }) }) }) }) }),
}));
beforeEach(() => {
  release.mockReset();
  release.mockResolvedValue(undefined);
  expiredRows = [{ shop_id: "s1", checkout_ref: "co1" }, { shop_id: "s1", checkout_ref: "co1" }];
});

describe("expireStaleReservations", () => {
  it("releases each distinct expired checkout once", async () => {
    const { expireStaleReservations } = await import("../reaper.server");
    const r = await expireStaleReservations();
    expect(release).toHaveBeenCalledTimes(1); // dedupes co1
    expect(r).toEqual({ released: 1, failed: 0 });
  });

  it("isolates a failing release: it does NOT abort the sweep, and the rest still release", async () => {
    // Three distinct stale holds across two shops; the FIRST release throws (transient error).
    expiredRows = [
      { shop_id: "s1", checkout_ref: "co1" },
      { shop_id: "s1", checkout_ref: "co2" },
      { shop_id: "s2", checkout_ref: "co3" },
    ];
    release
      .mockRejectedValueOnce(new Error("transient release blip"))
      .mockResolvedValue(undefined);

    const { expireStaleReservations } = await import("../reaper.server");
    const r = await expireStaleReservations();

    // All three were attempted (the throw did not short-circuit the loop), two succeeded, one failed.
    expect(release).toHaveBeenCalledTimes(3);
    expect(r).toEqual({ released: 2, failed: 1 });
  });
});
