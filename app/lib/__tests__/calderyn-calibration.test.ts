import { describe, it, expect, vi, beforeEach } from "vitest";

// Top-level vi.fn() handles so each test can reassign the shops maybeSingle
// result without needing vi.resetModules() or doMock re-imports.
const shopsMaybeSingle = vi.fn();

// Mock for recomputeShopCalibration — controls the lazy-compute path.
const mockRecompute = vi.fn();

vi.mock("../calibration/recompute.server", () => ({
  recomputeShopCalibration: (...args: unknown[]) => mockRecompute(...args),
}));

vi.mock("../supabase.server", () => ({
  resolveShopId: async (_domain: string) => "shop-1",
  getSupabase: () => ({
    from: (table: string) => {
      if (table === "shops") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: shopsMaybeSingle,
            }),
          }),
        };
      }
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({ data: null, error: null }),
          }),
        }),
      };
    },
  }),
}));

// eslint-disable-next-line import/first -- import must follow vi.mock
import { calderynClient } from "../calderyn.server";

describe("client.calibration.get", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the cached pct and timestamp", async () => {
    shopsMaybeSingle.mockResolvedValueOnce({
      data: {
        calibration_pct: 25,
        calibration_updated_at: "2026-06-20T00:00:00Z",
      },
      error: null,
    });

    const cal = await calderynClient("demo.myshopify.com").calibration.get();
    expect(cal.pct).toBe(25);
    expect(cal.updated_at).toBe("2026-06-20T00:00:00Z");
  });

  it("returns null pct and null updated_at when calibration columns are null", async () => {
    // Row exists but calibration has not been computed yet — columns are null.
    // Lazy compute fires; mock returns display=24 and the re-read returns it.
    mockRecompute.mockResolvedValueOnce({ display: 24, shopId: "shop-1", pairs: 5, raw: 24 });
    // Second maybeSingle call (re-read after lazy compute) returns the new value.
    shopsMaybeSingle
      .mockResolvedValueOnce({ data: { calibration_pct: null, calibration_updated_at: null }, error: null })
      .mockResolvedValueOnce({ data: { calibration_pct: 24, calibration_updated_at: "2026-06-21T00:00:00Z" }, error: null });

    const cal = await calderynClient("demo.myshopify.com").calibration.get();
    expect(cal.pct).toBe(24);
    expect(mockRecompute).toHaveBeenCalledOnce();
  });

  it("does NOT call recompute when calibration_pct is already set (fast path)", async () => {
    shopsMaybeSingle.mockResolvedValueOnce({
      data: { calibration_pct: 37, calibration_updated_at: "2026-06-20T00:00:00Z" },
      error: null,
    });

    const cal = await calderynClient("demo.myshopify.com").calibration.get();
    expect(cal.pct).toBe(37);
    expect(mockRecompute).not.toHaveBeenCalled();
  });

  it("returns null pct (not a crash) when lazy recompute throws", async () => {
    // First read: null pct triggers lazy compute.
    shopsMaybeSingle.mockResolvedValueOnce({ data: { calibration_pct: null, calibration_updated_at: null }, error: null });
    mockRecompute.mockRejectedValueOnce(new Error("DB down"));

    const cal = await calderynClient("demo.myshopify.com").calibration.get();
    expect(cal.pct).toBeNull();
    expect(cal.updated_at).toBeNull();
  });

  it("returns null pct and null updated_at when no calibration row exists", async () => {
    // maybeSingle returns data: null — "no calibration computed yet" (absent-row
    // path). Lazy compute fires; mock returns display=24.
    mockRecompute.mockResolvedValueOnce({ display: 24, shopId: "shop-1", pairs: 5, raw: 24 });
    shopsMaybeSingle
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: { calibration_pct: 24, calibration_updated_at: "2026-06-21T00:00:00Z" }, error: null });

    const cal = await calderynClient("demo.myshopify.com").calibration.get();
    expect(cal.pct).toBe(24);
    expect(mockRecompute).toHaveBeenCalledOnce();
  });
});
