import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isGraduated } from "../graduation.server";

/**
 * Build a minimal stub SupabaseClient for isGraduated.
 *
 * isGraduated calls:
 *   sb.from("pair_calibration").select(...).eq(...).eq(...).eq(...).maybeSingle()
 *   sb.from("calibration_rule").select(...).eq(...).eq(...).eq(...).eq(...)
 */
function sbWithPair(row: Record<string, unknown>) {
  const maybeSingle = vi.fn().mockResolvedValue({ data: row, error: null });

  // pair_calibration chain: select().eq().eq().eq().maybeSingle()
  const pairEq3 = vi.fn().mockReturnValue({ maybeSingle });
  const pairEq2 = vi.fn().mockReturnValue({ eq: pairEq3 });
  const pairEq1 = vi.fn().mockReturnValue({ eq: pairEq2 });
  const pairSelect = vi.fn().mockReturnValue({ eq: pairEq1 });

  // calibration_rule chain: select().eq().eq().eq().eq() → resolves with []
  const ruleEq4 = vi.fn().mockResolvedValue({ data: [], error: null });
  const ruleEq3 = vi.fn().mockReturnValue({ eq: ruleEq4 });
  const ruleEq2 = vi.fn().mockReturnValue({ eq: ruleEq3 });
  const ruleEq1 = vi.fn().mockReturnValue({ eq: ruleEq2 });
  const ruleSelect = vi.fn().mockReturnValue({ eq: ruleEq1 });

  return {
    from(table: string) {
      if (table === "pair_calibration") return { select: pairSelect };
      return { select: ruleSelect };
    },
  } as never as SupabaseClient;
}

describe("isGraduated outcome gate", () => {
  it("stays non-graduated when proven results are below the bar", async () => {
    // reduce_campaign_budget is a reversible non-no-brainer: needs MIN_OUTCOMES.reversible=3
    // net_positive_outcomes=1 < 3 → should be false
    const ok = await isGraduated(
      "s",
      "campaign_below_breakeven",
      "reduce_campaign_budget",
      sbWithPair({
        last_conf: 90,
        graduation_threshold: 75,
        clean_approvals: 10,
        consecutive_undos: 0,
        merchant_disabled: false,
        autonomy_enabled: true,
        net_positive_outcomes: 1,
        last_outcome_sign: 1,
      }),
    );
    expect(ok).toBe(false);
  });

  it("graduates when both bars and confidence are met", async () => {
    // net_positive_outcomes=5 >= MIN_OUTCOMES.reversible=3, last_outcome_sign=1 >= 0,
    // clean_approvals=10 >= MIN_APPROVALS.reversible=3, last_conf=90 >= threshold=75
    const ok = await isGraduated(
      "s",
      "campaign_below_breakeven",
      "reduce_campaign_budget",
      sbWithPair({
        last_conf: 90,
        graduation_threshold: 75,
        clean_approvals: 10,
        consecutive_undos: 0,
        merchant_disabled: false,
        autonomy_enabled: true,
        net_positive_outcomes: 5,
        last_outcome_sign: 1,
      }),
    );
    expect(ok).toBe(true);
  });
});
