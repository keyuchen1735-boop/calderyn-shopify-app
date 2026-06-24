import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isGraduated } from "../graduation.server";

/** A pair_calibration row where all graduation gates pass. */
const PASSING_ROW = {
  last_conf: 74,
  graduation_threshold: 75,
  clean_approvals: 0,
  consecutive_undos: 0,
  merchant_disabled: false,
};

/**
 * Build a minimal stub SupabaseClient for isGraduated.
 *
 * isGraduated calls:
 *   sb.from("pair_calibration").select(...).eq(...).eq(...).eq(...).maybeSingle()
 *   sb.from("calibration_rule").select(...).eq(...).eq(...).eq(...).eq(...)  [returns array]
 */
function makeStub(opts: {
  pairRow: Record<string, unknown> | null;
  pairError?: { message: string } | null;
  rules?: Array<{ rule_kind: string; rule_value: unknown }>;
  rulesError?: { message: string } | null;
  throwOnPair?: boolean;
}) {
  const maybeSingle = vi.fn().mockResolvedValue({
    data: opts.pairRow,
    error: opts.pairError ?? null,
  });

  // pair_calibration chain: select().eq().eq().eq().maybeSingle()
  const pairEq3 = vi.fn().mockReturnValue({ maybeSingle });
  const pairEq2 = vi.fn().mockReturnValue({ eq: pairEq3 });
  const pairEq1 = vi.fn().mockReturnValue({ eq: pairEq2 });
  const pairSelect = vi.fn().mockReturnValue({ eq: pairEq1 });

  // calibration_rule chain: select().eq().eq().eq().eq()  → resolves with array
  const ruleEq4 = vi.fn().mockResolvedValue({
    data: opts.rules ?? [],
    error: opts.rulesError ?? null,
  });
  const ruleEq3 = vi.fn().mockReturnValue({ eq: ruleEq4 });
  const ruleEq2 = vi.fn().mockReturnValue({ eq: ruleEq3 });
  const ruleEq1 = vi.fn().mockReturnValue({ eq: ruleEq2 });
  const ruleSelect = vi.fn().mockReturnValue({ eq: ruleEq1 });

  const from = vi.fn().mockImplementation((table: string) => {
    if (table === "pair_calibration") {
      if (opts.throwOnPair) throw new Error("network error");
      return { select: pairSelect };
    }
    // calibration_rule
    return { select: ruleSelect };
  });

  const sb = { from } as unknown as SupabaseClient;
  return { sb, from, maybeSingle, pairSelect, ruleSelect };
}

describe("isGraduated — happy path", () => {
  it("returns true for a shipped no-brainer without approval history", async () => {
    const { sb } = makeStub({ pairRow: PASSING_ROW, rules: [] });
    const result = await isGraduated("shop-1", "campaign_below_breakeven", "pause_campaign", sb);
    expect(result).toBe(true);
  });
});

describe("isGraduated — blocking rules", () => {
  it("returns false when a muted_pair rule is active", async () => {
    const { sb } = makeStub({
      pairRow: PASSING_ROW,
      rules: [{ rule_kind: "muted_pair", rule_value: {} }],
    });
    const result = await isGraduated("shop-1", "campaign_below_breakeven", "pause_campaign", sb);
    expect(result).toBe(false);
  });

  it("returns false when an active probation rule has until > now", async () => {
    const futureIso = new Date(Date.now() + 7 * 86400_000).toISOString(); // 7 days from now
    const { sb } = makeStub({
      pairRow: PASSING_ROW,
      rules: [
        {
          rule_kind: "pair_probation_until",
          rule_value: { until: futureIso },
        },
      ],
    });
    const result = await isGraduated("shop-1", "campaign_below_breakeven", "pause_campaign", sb);
    expect(result).toBe(false);
  });

  it("returns true when a probation rule has until <= now (expired)", async () => {
    const pastIso = new Date(Date.now() - 86400_000).toISOString(); // yesterday
    const { sb } = makeStub({
      pairRow: PASSING_ROW,
      rules: [
        {
          rule_kind: "pair_probation_until",
          rule_value: { until: pastIso },
        },
      ],
    });
    const result = await isGraduated("shop-1", "campaign_below_breakeven", "pause_campaign", sb);
    expect(result).toBe(true);
  });
});

describe("isGraduated — missing or errored row", () => {
  it("returns false when pair_calibration row is missing (null)", async () => {
    const { sb } = makeStub({ pairRow: null, rules: [] });
    const result = await isGraduated("shop-1", "campaign_below_breakeven", "pause_campaign", sb);
    expect(result).toBe(false);
  });

  it("returns false when pair_calibration read errors (fail-safe)", async () => {
    const { sb } = makeStub({
      pairRow: null,
      pairError: { message: "connection refused" },
      rules: [],
    });
    const result = await isGraduated("shop-1", "campaign_below_breakeven", "pause_campaign", sb);
    expect(result).toBe(false);
  });

  it("returns false when calibration_rule read errors (fail-safe)", async () => {
    const { sb } = makeStub({
      pairRow: PASSING_ROW,
      rulesError: { message: "timeout" },
    });
    const result = await isGraduated("shop-1", "campaign_below_breakeven", "pause_campaign", sb);
    expect(result).toBe(false);
  });

  it("returns false and does not throw when from() throws (fail-safe)", async () => {
    const { sb } = makeStub({ pairRow: PASSING_ROW, throwOnPair: true });
    await expect(
      isGraduated("shop-1", "campaign_below_breakeven", "pause_campaign", sb),
    ).resolves.toBe(false);
  });
});

describe("isGraduated — action kind must be in v1 set", () => {
  it("returns false for increase_campaign_budget even if row is perfect", async () => {
    const { sb } = makeStub({ pairRow: PASSING_ROW, rules: [] });
    const result = await isGraduated(
      "shop-1",
      "campaign_scaling_opportunity",
      "increase_campaign_budget",
      sb,
    );
    expect(result).toBe(false);
  });

  it("returns false for reallocate_inventory even if row is perfect", async () => {
    const { sb } = makeStub({ pairRow: PASSING_ROW, rules: [] });
    const result = await isGraduated(
      "shop-1",
      "regional_shortage_risk",
      "reallocate_inventory",
      sb,
    );
    expect(result).toBe(false);
  });
});
