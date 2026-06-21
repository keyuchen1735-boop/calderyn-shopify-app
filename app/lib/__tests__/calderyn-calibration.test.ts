import { describe, it, expect, vi, beforeEach } from "vitest";

// Top-level vi.fn() handles so each test can reassign the shops maybeSingle
// result without needing vi.resetModules() or doMock re-imports.
const shopsMaybeSingle = vi.fn();

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
    shopsMaybeSingle.mockResolvedValueOnce({
      data: { calibration_pct: null, calibration_updated_at: null },
      error: null,
    });

    const cal = await calderynClient("demo.myshopify.com").calibration.get();
    expect(cal.pct).toBeNull();
    expect(cal.updated_at).toBeNull();
  });

  it("returns null pct and null updated_at when no calibration row exists", async () => {
    // maybeSingle returns data: null — "no calibration computed yet" (UI shows
    // "calibrating" spinner). This is the absent-row path.
    shopsMaybeSingle.mockResolvedValueOnce({ data: null, error: null });

    const cal = await calderynClient("demo.myshopify.com").calibration.get();
    expect(cal.pct).toBeNull();
    expect(cal.updated_at).toBeNull();
  });
});
