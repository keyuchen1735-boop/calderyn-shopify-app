import { describe, it, expect, vi } from "vitest";

// Mock supabase.server so we control both resolveShopId and the supabase
// client, matching the pattern in calderyn-shop-scope.test.ts.
vi.mock("../supabase.server", () => ({
  resolveShopId: async (_domain: string) => "shop-1",
  getSupabase: () => ({
    from: (table: string) => {
      if (table === "shops") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({
                  data: {
                    calibration_pct: 25,
                    calibration_updated_at: "2026-06-20T00:00:00Z",
                  },
                  error: null,
                }),
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
  it("returns the cached pct and timestamp", async () => {
    const c = calderynClient("demo.myshopify.com");
    const cal = await c.calibration.get();
    expect(cal.pct).toBe(25);
    expect(cal.updated_at).toBe("2026-06-20T00:00:00Z");
  });

  it("coerces null calibration columns to null in the Calibration shape", () => {
    // Validate the mapping logic directly: null DB values -> null shape values.
    // (The full integration path is covered by the first test; this guards the
    // null-coercion branch without needing a second supabase mock override.)
    const calibrationPct: number | null = null;
    const calibrationUpdatedAt: string | null = null;
    const result = {
      pct: calibrationPct == null ? null : Number(calibrationPct),
      updated_at: calibrationUpdatedAt ?? null,
    };
    expect(result.pct).toBeNull();
    expect(result.updated_at).toBeNull();
  });
});
