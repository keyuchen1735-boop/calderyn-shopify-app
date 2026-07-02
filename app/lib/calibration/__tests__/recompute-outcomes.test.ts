/**
 * Task 8 — outcome tallies flow through the nightly recompute.
 *
 * Asserts two paths:
 *  A. Positive-outcomes path: a pair with enough approvals + 5 positive
 *     closed-window rewards → pair_calibration update has
 *     net_positive_outcomes: 5 and graduated: true.
 *  B. Demotion path: same pair but whose MOST RECENT closed reward is
 *     negative → update has graduated: false and last_outcome_sign: -1.
 *
 * The fake SupabaseClient extends the pattern from recompute.test.ts's
 * makeStubSb: handles pair_calibration, alerts, shops, rpc — and adds an
 * action_audit branch so loadPairOutcomeTallies gets its rows.
 */

import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { recomputeShopCalibration } from "../recompute.server";

// ---------------------------------------------------------------------------
// Fake SupabaseClient builder
// ---------------------------------------------------------------------------

interface AuditRewardRow {
  action_kind: string;
  reward_signal: number;
  reward_window_closed_at: string;
  alerts: { detector_id: string } | null;
}

function makeStubSbWithOutcomes(opts: {
  /** pair_calibration rows for this shop. */
  pairRows: Record<string, unknown>[];
  /** detector fire counts (for the alerts table). */
  detectorFires: Record<string, number>;
  /** action_audit rows returned by the closed-window tally select. */
  auditRewardRows: AuditRewardRow[];
  /** Previous shops.calibration_pct (null = cold start). */
  prevPct: number | null;
  /** Called with each batched pair_calibration cache upsert payload. */
  onPairUpsert?: (rows: Array<Record<string, unknown>>) => void;
}) {
  return {
    from(table: string) {
      // ── pair_calibration ──────────────────────────────────────────────────
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

      // ── shops ─────────────────────────────────────────────────────────────
      if (table === "shops") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({
                  data: { calibration_pct: opts.prevPct },
                  error: null,
                }),
            }),
          }),
          update: (patch: Record<string, unknown>) => ({
            eq: () => Promise.resolve({ error: null }),
          }),
        };
      }

      // ── action_audit (closed-window outcome tally) ────────────────────────
      // loadPairOutcomeTallies issues:
      //   .from("action_audit")
      //     .select("action_kind, reward_signal, reward_window_closed_at, alerts!inner(detector_id)")
      //     .eq("shop_id", shopId)
      //     .not("reward_window_closed_at", "is", null)
      if (table === "action_audit") {
        return {
          select: () => ({
            eq: () => ({
              not: () =>
                Promise.resolve({ data: opts.auditRewardRows, error: null }),
            }),
          }),
        };
      }

      // Fallback for any unexpected table
      return {
        select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }),
      };
    },
    rpc: (name: string) => {
      if (name === "calibration_detector_stats") {
        const rows = Object.entries(opts.detectorFires).map(([d, n]) => ({
          detector_id: d,
          fired: n,
          challenged: 0,
        }));
        return Promise.resolve({ data: rows, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
  } as unknown as SupabaseClient;
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

// A pair that meets all graduation gates for reduce_campaign_budget
// (reversible tier, MIN_APPROVALS.reversible = 3, MIN_OUTCOMES.reversible = 3).
// We use graduation_threshold: 0 so any conf passes the confidence bar.
const ELIGIBLE_PAIR_ROW = {
  detector_id: "campaign_below_breakeven",
  action_kind: "reduce_campaign_budget",
  alpha: 50, // high alpha → high conf
  beta: 2,
  clean_approvals: 10, // well above MIN_APPROVALS.reversible (3)
  consecutive_undos: 0,
  merchant_disabled: false,
  graduation_threshold: 0, // conf always >= 0 → confidence bar always passes
  net_positive_outcomes: 0, // stored row value (will be overwritten by tally)
  last_outcome_sign: 0,
};

const DETECTOR = "campaign_below_breakeven";
const ACTION = "reduce_campaign_budget";

// ---------------------------------------------------------------------------
// Path A: positive outcomes → graduated=true, net_positive_outcomes=5
// ---------------------------------------------------------------------------

const findRow = (
  batches: Array<Array<Record<string, unknown>>>,
  detector: string,
  action: string,
) => batches.flat().find((r) => r.detector_id === detector && r.action_kind === action);

describe("recompute-outcomes — positive path", () => {
  it(
    "writes net_positive_outcomes=5 and graduated=true when 5 positive rewards arrive",
    async () => {
      const batches: Array<Array<Record<string, unknown>>> = [];

      // 5 positive closed rewards, all attributed to the same pair
      const auditRows: AuditRewardRow[] = Array.from({ length: 5 }, (_, i) => ({
        action_kind: ACTION,
        reward_signal: 10 + i,
        reward_window_closed_at: `2026-06-${String(20 + i).padStart(2, "0")}T00:00:00Z`,
        alerts: { detector_id: DETECTOR },
      }));

      const sb = makeStubSbWithOutcomes({
        pairRows: [ELIGIBLE_PAIR_ROW],
        detectorFires: { campaign_below_breakeven: 5 },
        auditRewardRows: auditRows,
        prevPct: null,
        onPairUpsert: (rows) => batches.push(rows),
      });

      await recomputeShopCalibration("shop-outcomes-1", { sb }, { skipPeerPrior: true });

      const hit = findRow(batches, DETECTOR, ACTION);
      expect(hit).toBeDefined();
      // Task 8 assertion A: net_positive_outcomes from the tally
      expect(hit!.net_positive_outcomes).toBe(5);
      // All gates pass with 5 positive outcomes → graduated
      expect(hit!.graduated).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// Path B: most-recent reward negative → demotion (graduated=false, last_outcome_sign=-1)
// ---------------------------------------------------------------------------

describe("recompute-outcomes — demotion path", () => {
  it(
    "writes graduated=false and last_outcome_sign=-1 when the most recent reward is negative",
    async () => {
      const batches: Array<Array<Record<string, unknown>>> = [];

      // 4 positive rewards followed by 1 NEGATIVE reward (latest closedAt)
      const auditRows: AuditRewardRow[] = [
        ...Array.from({ length: 4 }, (_, i) => ({
          action_kind: ACTION,
          reward_signal: 8 + i,
          reward_window_closed_at: `2026-06-${String(20 + i).padStart(2, "0")}T00:00:00Z`,
          alerts: { detector_id: DETECTOR },
        })),
        {
          action_kind: ACTION,
          reward_signal: -100, // the undo/loss penalty
          reward_window_closed_at: "2026-06-25T00:00:00Z", // LATEST
          alerts: { detector_id: DETECTOR },
        },
      ];

      const sb = makeStubSbWithOutcomes({
        pairRows: [ELIGIBLE_PAIR_ROW],
        detectorFires: { campaign_below_breakeven: 5 },
        auditRewardRows: auditRows,
        prevPct: null,
        onPairUpsert: (rows) => batches.push(rows),
      });

      await recomputeShopCalibration("shop-outcomes-2", { sb }, { skipPeerPrior: true });

      const hit = findRow(batches, DETECTOR, ACTION);
      expect(hit).toBeDefined();
      // Task 8 assertion B: demotion — most recent reward is negative
      expect(hit!.graduated).toBe(false);
      expect(hit!.last_outcome_sign).toBe(-1);
    },
  );
});
