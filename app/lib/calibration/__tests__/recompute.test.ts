import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { computeWeights, recomputeShopCalibration } from "../recompute.server";

describe("computeWeights", () => {
  it("splits each detector's weight across its GRADUATABLE actions with rank-decay", () => {
    const w = computeWeights({ campaign_below_breakeven: 10 });
    // campaign_below_breakeven -> [pause_campaign, reduce_campaign_budget, snooze_alert].
    // snooze_alert has no executor (never graduates), so it must be OUT of the
    // weight universe — otherwise its 0-confidence weight caps the shop headline.
    const pause = w.find((x) => x.action === "pause_campaign");
    const reduce = w.find((x) => x.action === "reduce_campaign_budget");
    expect(w.find((x) => x.action === "snooze_alert")).toBeUndefined();
    expect(pause!.weight).toBeGreaterThan(reduce!.weight); // first action ranked higher
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
    // Emergent-baseline canary: cold-start must land mid-range, and reaching 100
    // must stay POSSIBLE (the executor-only weight universe removed the structural
    // cap that used to hold the baseline near ~36).
    // Kills always-0 regression:
    expect(res.display).toBeGreaterThan(0);
    // Kills always-100 and always-50 regressions:
    expect(res.display).toBeLessThan(100);
    expect(res.display).not.toBe(50);
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

    // raw is 49 with the executor-only weight universe; prev 48 keeps the smoothed
    // move inside the dead-band so the forced path is what makes it visible.
    const normal = await recomputeShopCalibration("shop-visible-1", {
      sb: makeStubSb({
        pairRows,
        detectorFires: { campaign_scaling_opportunity: 5 },
        prevPct: 48,
        onShopUpdate: (patch) => normalUpdates.push(patch),
      }),
    }, { skipPeerPrior: true });

    const forced = await recomputeShopCalibration("shop-visible-2", {
      sb: makeStubSb({
        pairRows,
        detectorFires: { campaign_scaling_opportunity: 5 },
        prevPct: 48,
        onShopUpdate: (patch) => forcedUpdates.push(patch),
      }),
    }, { skipPeerPrior: true, forceVisibleStep: true });

    expect(normal.raw).toBe(49);
    expect(normal.display).toBe(48);
    expect(forced.raw).toBe(49);
    expect(forced.display).toBe(49);
    expect(forcedUpdates[0]).toHaveProperty("calibration_pct", 49);
  });
});

// Minimal Supabase stub: supports the exact call chain recompute uses.
function makeStubSb(opts: {
  pairRows: Record<string, unknown>[];
  detectorFires: Record<string, number>;
  detectorChallenges?: Record<string, number>;
  prevPct: number | null;
  onShopUpdate: (patch: Record<string, unknown>) => void;
  onPairUpsert?: (rows: Array<Record<string, unknown>>) => void;
  onRpc?: (name: string, args: unknown) => void;
  /** Simulate the stats RPC being unavailable (migration skew / timeout). */
  statsRpcError?: boolean;
}) {
  return {
    from(table: string) {
      if (table === "alerts") {
        // Legacy fires fallback: select().eq().gte().limit()
        const rows = Object.entries(opts.detectorFires).flatMap(([d, n]) =>
          Array.from({ length: n }, () => ({ detector_id: d })),
        );
        return {
          select: () => ({
            eq: () => ({ gte: () => ({ limit: () => Promise.resolve({ data: rows, error: null }) }) }),
          }),
        };
      }
      if (table === "action_feedback") {
        // Legacy challenge fallback: select().eq().eq().in().gte().limit()
        const chain: Record<string, unknown> = {};
        chain.eq = () => chain;
        chain.in = () => chain;
        chain.gte = () => chain;
        chain.limit = () => Promise.resolve({ data: [], error: null });
        return { select: () => chain };
      }
      if (table === "pair_calibration") {
        return {
          select: () => ({
            eq: () => Promise.resolve({ data: opts.pairRows, error: null }),
          }),
          // Batched cache write: ONE upsert with all rows (the N+1 fix).
          upsert: (rows: Array<Record<string, unknown>>) => {
            opts.onPairUpsert?.(rows);
            return Promise.resolve({ error: null });
          },
        };
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
      // loadPairOutcomeTallies (action_audit) — fail-safe empty in these tests.
      return { select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) };
    },
    rpc: (name: string, args: unknown) => {
      opts.onRpc?.(name, args);
      if (name === "calibration_detector_stats" && opts.statsRpcError) {
        return Promise.resolve({ data: null, error: { message: "function not found" } });
      }
      if (name === "calibration_detector_stats") {
        const detectors = new Set([
          ...Object.keys(opts.detectorFires),
          ...Object.keys(opts.detectorChallenges ?? {}),
        ]);
        const rows = [...detectors].map((d) => ({
          detector_id: d,
          fired: opts.detectorFires[d] ?? 0,
          challenged: (opts.detectorChallenges ?? {})[d] ?? 0,
        }));
        return Promise.resolve({ data: rows, error: null });
      }
      // action_pair_priors: no peer baselines → static seeds.
      return Promise.resolve({ data: [], error: null });
    },
  } as unknown as SupabaseClient;
}

// ─── peer-prior sourcing ─────────────────────────────────────────────────────

describe("recomputeShopCalibration — peer-prior sourcing", () => {
  it("skipPeerPrior=true never fetches priors and still returns display in [0,100]", async () => {
    const rpcNames: string[] = [];
    const sb = makeStubSb({
      pairRows: [],
      detectorFires: { campaign_below_breakeven: 3 },
      prevPct: null,
      onShopUpdate: () => {},
      onRpc: (name) => rpcNames.push(name),
    });

    const res = await recomputeShopCalibration("shop-skip-1", { sb }, { skipPeerPrior: true });
    expect(rpcNames).not.toContain("action_pair_priors");
    expect(res.display).toBeGreaterThanOrEqual(0);
    expect(res.display).toBeLessThanOrEqual(100);
  });

  it("fetches priors in exactly ONE bulk call on the default path (never per pair)", async () => {
    const rpcNames: string[] = [];
    const sb = makeStubSb({
      pairRows: [],
      detectorFires: { campaign_below_breakeven: 3 },
      prevPct: null,
      onShopUpdate: () => {},
      onRpc: (name) => rpcNames.push(name),
    });

    await recomputeShopCalibration("shop-skip-2", { sb });
    expect(rpcNames.filter((n) => n === "action_pair_priors")).toHaveLength(1);
    expect(rpcNames).not.toContain("action_pair_prior"); // the retired per-pair fn
  });

  it("falls back to the legacy reads when the stats RPC is unavailable (fail-soft)", async () => {
    const updates: Record<string, unknown>[] = [];
    const sb = makeStubSb({
      pairRows: [],
      detectorFires: { campaign_below_breakeven: 3 },
      prevPct: null,
      onShopUpdate: (patch) => updates.push(patch),
      statsRpcError: true,
    });
    // Same detector fires arrive via the legacy alerts read, so the headline
    // still computes and writes — a stats hiccup never freezes calibration.
    const res = await recomputeShopCalibration("shop-fallback-1", { sb }, { skipPeerPrior: true });
    expect(res.display).toBeGreaterThan(0);
    expect(updates[0]).toHaveProperty("calibration_pct", res.display);
  });

  it("uses a caller-provided shared prior map without fetching (the cron path)", async () => {
    const rpcNames: string[] = [];
    const sb = makeStubSb({
      pairRows: [],
      detectorFires: { campaign_below_breakeven: 3 },
      prevPct: null,
      onShopUpdate: () => {},
      onRpc: (name) => rpcNames.push(name),
    });

    await recomputeShopCalibration(
      "shop-skip-3",
      { sb },
      { peerPriors: new Map([["campaign_below_breakeven:pause_campaign", 0.8]]) },
    );
    expect(rpcNames).not.toContain("action_pair_priors");
  });
});

// ─── Slice 5 Task 2: graduated cache tests ───────────────────────────────────

describe("recomputeShopCalibration — graduated cache (Slice 5 Task 2)", () => {
  // The cache write is ONE batched upsert; find a pair's row inside it.
  const findRow = (
    batches: Array<Array<Record<string, unknown>>>,
    detector: string,
    action: string,
  ) =>
    batches
      .flat()
      .find((r) => r.detector_id === detector && r.action_kind === action);

  it("keeps a shipped no-brainer graduated at cold start (single batched upsert)", async () => {
    const batches: Array<Array<Record<string, unknown>>> = [];
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
      onPairUpsert: (rows) => batches.push(rows),
    });
    await recomputeShopCalibration("shop-grad-1", { sb });
    // The whole cache lands in ONE round trip (the N+1 fix).
    expect(batches).toHaveLength(1);
    const row = findRow(batches, "campaign_below_breakeven", "pause_campaign");
    expect(row).toBeDefined();
    expect(row!.graduated).toBe(true);
    // last_conf must be a non-negative integer; alpha/beta must NOT be in the
    // payload (the batch writes cache columns only, never the counters).
    expect(typeof row!.last_conf).toBe("number");
    expect(row!.last_conf as number).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(row!.last_conf)).toBe(true);
    expect(row).not.toHaveProperty("alpha");
    expect(row).not.toHaveProperty("beta");
  });

  it("writes graduated=true for a pair meeting ALL graduation gates", async () => {
    const batches: Array<Array<Record<string, unknown>>> = [];
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
      net_positive_outcomes: 5,
    };
    const sb = makeStubSb({
      pairRows: [pairRow],
      detectorFires: { campaign_below_breakeven: 5 },
      prevPct: null,
      onShopUpdate: () => {},
      onPairUpsert: (rows) => batches.push(rows),
    });
    await recomputeShopCalibration("shop-grad-2", { sb });
    const row = findRow(batches, "campaign_below_breakeven", "pause_campaign");
    expect(row).toBeDefined();
    // pause_campaign is in GRADUATABLE, has undo branch, all gates pass → graduated.
    expect(row!.graduated).toBe(true);
    expect(row!.last_conf as number).toBeGreaterThanOrEqual(0);
  });

  it("writes graduated=false for increase_campaign_budget (not in GRADUATABLE)", async () => {
    const batches: Array<Array<Record<string, unknown>>> = [];
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
      onPairUpsert: (rows) => batches.push(rows),
    });
    await recomputeShopCalibration("shop-grad-3", { sb });
    const row = findRow(batches, "campaign_scaling_opportunity", "increase_campaign_budget");
    expect(row).toBeDefined();
    // Not in GRADUATABLE → never graduated.
    expect(row!.graduated).toBe(false);
  });

  it("does NOT write any cache batch for pairs with no row (cold start, no ev)", async () => {
    // No pair rows → pairMap is empty → the upsert must not run at all.
    const batches: unknown[] = [];
    const sb = makeStubSb({
      pairRows: [],
      detectorFires: {},
      prevPct: null,
      onShopUpdate: () => {},
      onPairUpsert: () => batches.push(1),
    });
    await recomputeShopCalibration("shop-grad-4", { sb });
    expect(batches).toHaveLength(0);
  });
});
