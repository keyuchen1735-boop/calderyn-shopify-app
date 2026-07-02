import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
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

  it("can force a visible one-point display move after an interactive signal", async () => {
    const normalUpdates: Record<string, unknown>[] = [];
    const forcedUpdates: Record<string, unknown>[] = [];
    const pairRows = [
      {
        detector_id: "campaign_scaling_opportunity",
        action_kind: "increase_campaign_budget",
        alpha: 0,
        beta: 0,
        clean_approvals: 0,
        consecutive_undos: 0,
        merchant_disabled: false,
        graduation_threshold: 75,
      },
    ];

    // raw is 35 with the full executor catalog (exclude_geo/push_creative_draft
    // pairs are real now, not zeros); prev 34 keeps the smoothed move inside the
    // dead-band so the forced path is what makes it visible.
    const normal = await recomputeShopCalibration("shop-visible-1", {
      sb: makeStubSb({
        pairRows,
        detectorFires: { campaign_scaling_opportunity: 5 },
        prevPct: 34,
        onShopUpdate: (patch) => normalUpdates.push(patch),
      }),
    }, { skipPeerPrior: true });

    const forced = await recomputeShopCalibration("shop-visible-2", {
      sb: makeStubSb({
        pairRows,
        detectorFires: { campaign_scaling_opportunity: 5 },
        prevPct: 34,
        onShopUpdate: (patch) => forcedUpdates.push(patch),
      }),
    }, { skipPeerPrior: true, forceVisibleStep: true });

    expect(normal.raw).toBe(35);
    expect(normal.display).toBe(34);
    expect(forced.raw).toBe(35);
    expect(forced.display).toBe(35);
    expect(forcedUpdates[0]).toHaveProperty("calibration_pct", 35);
  });
});

// Minimal Supabase stub: supports the exact call chain recompute uses.
function makeStubSb(opts: {
  pairRows: Record<string, unknown>[];
  detectorFires: Record<string, number>;
  prevPct: number | null;
  onShopUpdate: (patch: Record<string, unknown>) => void;
  onPairUpdate?: (patch: Record<string, unknown>, detector: string, action: string) => void;
}) {
  return {
    from(table: string) {
      if (table === "pair_calibration") {
        return {
          select: () => ({
            eq: () => Promise.resolve({ data: opts.pairRows, error: null }),
          }),
          update: (patch: Record<string, unknown>) => ({
            eq: (_col1: string, _val1: string) => ({
              eq: (_col2: string, detector: string) => ({
                eq: (_col3: string, action: string) => {
                  opts.onPairUpdate?.(patch, detector, action);
                  return Promise.resolve({ error: null });
                },
              }),
            }),
          }),
        };
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
  } as unknown as SupabaseClient;
}

// ─── skipPeerPrior option ─────────────────────────────────────────────────────

describe("recomputeShopCalibration — skipPeerPrior option", () => {
  it("does NOT call sb.rpc when skipPeerPrior=true and still returns display in [0,100]", async () => {
    const rpcCalls: unknown[] = [];
    const sb = makeStubSb({
      pairRows: [],
      detectorFires: { campaign_below_breakeven: 3 },
      prevPct: null,
      onShopUpdate: () => {},
    });
    // Wrap rpc to track calls.
    const trackedSb = {
      ...sb,
      rpc: (...args: unknown[]) => {
        rpcCalls.push(args);
        return Promise.resolve({ data: null, error: null });
      },
    } as unknown as typeof sb;

    const res = await recomputeShopCalibration("shop-skip-1", { sb: trackedSb }, { skipPeerPrior: true });
    expect(rpcCalls).toHaveLength(0); // no rpc called
    expect(res.display).toBeGreaterThanOrEqual(0);
    expect(res.display).toBeLessThanOrEqual(100);
  });

  it("DOES call sb.rpc when skipPeerPrior is not set (default path)", async () => {
    const rpcCalls: unknown[] = [];
    const sb = makeStubSb({
      pairRows: [],
      detectorFires: { campaign_below_breakeven: 3 },
      prevPct: null,
      onShopUpdate: () => {},
    });
    const trackedSb = {
      ...sb,
      rpc: (...args: unknown[]) => {
        rpcCalls.push(args);
        return Promise.resolve({ data: null, error: null });
      },
    } as unknown as typeof sb;

    await recomputeShopCalibration("shop-skip-2", { sb: trackedSb });
    // rpc is called once per weight pair (many pairs for a real detector)
    expect(rpcCalls.length).toBeGreaterThan(0);
  });
});

// ─── Slice 5 Task 2: graduated cache tests ───────────────────────────────────

describe("recomputeShopCalibration — graduated cache (Slice 5 Task 2)", () => {
  it("keeps a shipped no-brainer graduated at cold start", async () => {
    const pairUpdates: { patch: Record<string, unknown>; detector: string; action: string }[] = [];
    // A pair with zero approvals (clean_approvals=0): should NOT graduate.
    const pairRow = {
      detector_id: "campaign_below_breakeven",
      action_kind: "pause_campaign",
      alpha: 0,
      beta: 0,
      clean_approvals: 0,
      consecutive_undos: 0,
      merchant_disabled: false,
      graduation_threshold: 75,
    };
    const sb = makeStubSb({
      pairRows: [pairRow],
      detectorFires: { campaign_below_breakeven: 5 },
      prevPct: null,
      onShopUpdate: () => {},
      onPairUpdate: (patch, detector, action) => pairUpdates.push({ patch, detector, action }),
    });
    await recomputeShopCalibration("shop-grad-1", { sb });
    // At least one pair update for campaign_below_breakeven:pause_campaign.
    const targetUpdate = pairUpdates.find(
      (u) => u.detector === "campaign_below_breakeven" && u.action === "pause_campaign",
    );
    expect(targetUpdate).toBeDefined();
    expect(targetUpdate!.patch.graduated).toBe(true);
    // last_conf must be a non-negative integer.
    expect(typeof targetUpdate!.patch.last_conf).toBe("number");
    expect(targetUpdate!.patch.last_conf as number).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(targetUpdate!.patch.last_conf)).toBe(true);
  });

  it("writes graduated=true for a pair meeting ALL graduation gates", async () => {
    const pairUpdates: { patch: Record<string, unknown>; detector: string; action: string }[] = [];
    // A pair meeting all gates: high alpha (many approvals), clean_approvals>=3,
    // zero consecutive_undos, not disabled, threshold=0 (always meets bar).
    const pairRow = {
      detector_id: "campaign_below_breakeven",
      action_kind: "pause_campaign",
      alpha: 50,  // high alpha → high conf
      beta: 2,
      clean_approvals: 5,       // >= MIN_APPROVALS.reversible (3)
      consecutive_undos: 0,     // no recent undo
      merchant_disabled: false, // not disabled
      graduation_threshold: 0,  // conf always >= 0 → passes the bar
    };
    const sb = makeStubSb({
      pairRows: [pairRow],
      detectorFires: { campaign_below_breakeven: 5 },
      prevPct: null,
      onShopUpdate: () => {},
      onPairUpdate: (patch, detector, action) => pairUpdates.push({ patch, detector, action }),
    });
    await recomputeShopCalibration("shop-grad-2", { sb });
    const targetUpdate = pairUpdates.find(
      (u) => u.detector === "campaign_below_breakeven" && u.action === "pause_campaign",
    );
    expect(targetUpdate).toBeDefined();
    // pause_campaign is in GRADUATABLE, has undo branch, all gates pass → graduated.
    expect(targetUpdate!.patch.graduated).toBe(true);
    expect(targetUpdate!.patch.last_conf as number).toBeGreaterThanOrEqual(0);
  });

  it("writes graduated=false for increase_campaign_budget (not in GRADUATABLE)", async () => {
    const pairUpdates: { patch: Record<string, unknown>; detector: string; action: string }[] = [];
    // increase_campaign_budget cannot graduate (not in GRADUATABLE set, spec I7).
    const pairRow = {
      detector_id: "campaign_scaling_opportunity",
      action_kind: "increase_campaign_budget",
      alpha: 50,
      beta: 0,
      clean_approvals: 10,
      consecutive_undos: 0,
      merchant_disabled: false,
      graduation_threshold: 0,
    };
    const sb = makeStubSb({
      pairRows: [pairRow],
      detectorFires: { campaign_scaling_opportunity: 5 },
      prevPct: null,
      onShopUpdate: () => {},
      onPairUpdate: (patch, detector, action) => pairUpdates.push({ patch, detector, action }),
    });
    await recomputeShopCalibration("shop-grad-3", { sb });
    const targetUpdate = pairUpdates.find(
      (u) => u.detector === "campaign_scaling_opportunity" && u.action === "increase_campaign_budget",
    );
    expect(targetUpdate).toBeDefined();
    // Not in GRADUATABLE → never graduated.
    expect(targetUpdate!.patch.graduated).toBe(false);
  });

  it("does NOT write a pair update for pairs with no row (cold start, no ev)", async () => {
    // No pair rows → pairMap is empty → no update calls should happen.
    const pairUpdates: unknown[] = [];
    const sb = makeStubSb({
      pairRows: [],
      detectorFires: {},
      prevPct: null,
      onShopUpdate: () => {},
      onPairUpdate: () => pairUpdates.push(1),
    });
    await recomputeShopCalibration("shop-grad-4", { sb });
    expect(pairUpdates).toHaveLength(0);
  });
});
