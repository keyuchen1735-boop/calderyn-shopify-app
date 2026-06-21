import { describe, it, expect, vi } from "vitest";
import { computeWeights, recomputeShopCalibration } from "../recompute.server";

describe("computeWeights", () => {
  it("splits each detector's weight across its legal actions with rank-decay", () => {
    const w = computeWeights({ campaign_below_breakeven: 10 });
    // campaign_below_breakeven -> [pause_campaign, reduce_campaign_budget, snooze_alert]
    const pause = w.find((x) => x.action === "pause_campaign");
    const snooze = w.find((x) => x.action === "snooze_alert");
    expect(pause!.weight).toBeGreaterThan(snooze!.weight); // first action ranked higher
    const total = w.reduce((s, x) => s + x.weight, 0);
    expect(total).toBeGreaterThan(0);
  });
  it("gives a new shop (no fires) a non-empty seed distribution", () => {
    const w = computeWeights({});
    expect(w.length).toBeGreaterThan(0);
    expect(w.reduce((s, x) => s + x.weight, 0)).toBeGreaterThan(0);
  });
});

describe("recomputeShopCalibration", () => {
  it("writes a smoothed calibration_pct and returns the summary", async () => {
    const updates: Record<string, unknown>[] = [];
    const sb = makeStubSb({
      pairRows: [], // cold start, no per-pair evidence
      detectorFires: { sku_stockout_vs_spend: 5, campaign_below_breakeven: 3 },
      prevPct: null,
      onShopUpdate: (patch) => updates.push(patch),
    });
    const res = await recomputeShopCalibration("shop-1", { sb });
    expect(res.shopId).toBe("shop-1");
    expect(res.display).toBeGreaterThanOrEqual(0);
    expect(res.display).toBeLessThanOrEqual(100);
    expect(updates[0]).toHaveProperty("calibration_pct", res.display);
    expect(updates[0]).toHaveProperty("calibration_updated_at");
    // Emergent-baseline canary: cold-start must land in low-to-mid range (Task 10 measures live value).
    // Kills always-0 regression:
    expect(res.display).toBeGreaterThan(0);
    // Kills always-50/always-100 regression (foundation baseline observed ~36):
    expect(res.display).toBeLessThan(50);
    // Cold start with null prev: smooth is a no-op, so display must equal raw:
    expect(res.display).toBe(res.raw);
  });
});

// Minimal Supabase stub: supports the exact call chain recompute uses.
function makeStubSb(opts: {
  pairRows: Record<string, unknown>[];
  detectorFires: Record<string, number>;
  prevPct: number | null;
  onShopUpdate: (patch: Record<string, unknown>) => void;
}) {
  return {
    from(table: string) {
      if (table === "pair_calibration") {
        return { select: () => ({ eq: () => Promise.resolve({ data: opts.pairRows, error: null }) }) };
      }
      if (table === "alerts") {
        // recompute reads recent alerts to count detector fires
        const rows = Object.entries(opts.detectorFires).flatMap(([d, n]) =>
          Array.from({ length: n }, () => ({ detector_id: d })),
        );
        return { select: () => ({ eq: () => ({ gte: () => Promise.resolve({ data: rows, error: null }) }) }) };
      }
      if (table === "shops") {
        return {
          select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { calibration_pct: opts.prevPct }, error: null }) }) }),
          update: (patch: Record<string, unknown>) => {
            opts.onShopUpdate(patch);
            return { eq: () => Promise.resolve({ error: null }) };
          },
        };
      }
      // action_pair_prior is called via rpc, stubbed below
      return { select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) };
    },
    rpc: () => Promise.resolve({ data: null, error: null }), // peer prior absent -> static seed
  } as unknown as import("@supabase/supabase-js").SupabaseClient;
}
