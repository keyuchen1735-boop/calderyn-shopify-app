import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  applyRules,
  loadPairRules,
  loadAndApplyRules,
  type CalibrationRule,
  type RuleContext,
} from "../rule-enforce.server";

// ─── Helpers ──────────────────────────────────────────────────────────────

const BASE_CTX: RuleContext = {
  actionKind: "pause_campaign",
  dollarImpactCents: 1000,
  campaignSpendCents: 50000,
  nowUtcHour: 14, // 2pm UTC
  nowIso: "2026-06-21T14:00:00.000Z",
};

function rule(rule_kind: string, rule_value: Record<string, unknown> = {}): CalibrationRule {
  return { rule_kind, rule_value };
}

// ─── applyRules ───────────────────────────────────────────────────────────

describe("applyRules", () => {
  describe("muted_pair", () => {
    it("vetoes with 'merchant handles this'", () => {
      const result = applyRules([rule("muted_pair")], BASE_CTX);
      expect(result.veto).toBe("merchant handles this");
    });
  });

  describe("pair_probation_until", () => {
    it("vetoes when until > nowIso", () => {
      const result = applyRules(
        [rule("pair_probation_until", { until: "2026-07-01T00:00:00.000Z" })],
        BASE_CTX,
      );
      expect(result.veto).toContain("probation");
    });

    it("does NOT veto when until <= nowIso (probation expired)", () => {
      const result = applyRules(
        [rule("pair_probation_until", { until: "2026-06-01T00:00:00.000Z" })],
        BASE_CTX,
      );
      expect(result.veto).toBeUndefined();
    });

    it("does NOT veto when rule_value has no 'until' key", () => {
      const result = applyRules([rule("pair_probation_until", {})], BASE_CTX);
      expect(result.veto).toBeUndefined();
    });
  });

  describe("pair_blackout_hours", () => {
    it("vetoes when nowUtcHour is in hours list", () => {
      const result = applyRules(
        [rule("pair_blackout_hours", { hours: [12, 14, 16] })],
        { ...BASE_CTX, nowUtcHour: 14 },
      );
      expect(result.veto).toBe("outside merchant-allowed hours");
    });

    it("does NOT veto when nowUtcHour is NOT in hours list", () => {
      const result = applyRules(
        [rule("pair_blackout_hours", { hours: [12, 16] })],
        { ...BASE_CTX, nowUtcHour: 14 },
      );
      expect(result.veto).toBeUndefined();
    });

    it("does NOT veto when hours array is empty", () => {
      const result = applyRules(
        [rule("pair_blackout_hours", { hours: [] })],
        BASE_CTX,
      );
      expect(result.veto).toBeUndefined();
    });
  });

  describe("pair_min_spend", () => {
    it("vetoes when campaignSpendCents < cents", () => {
      const result = applyRules(
        [rule("pair_min_spend", { cents: 100000 })],
        { ...BASE_CTX, campaignSpendCents: 50000 },
      );
      expect(result.veto).toBe("below merchant min spend");
    });

    it("does NOT veto when campaignSpendCents >= cents", () => {
      const result = applyRules(
        [rule("pair_min_spend", { cents: 50000 })],
        { ...BASE_CTX, campaignSpendCents: 50000 },
      );
      expect(result.veto).toBeUndefined();
    });

    it("does NOT veto when cents key missing", () => {
      const result = applyRules([rule("pair_min_spend", {})], BASE_CTX);
      expect(result.veto).toBeUndefined();
    });
  });

  describe("pair_dollar_cap", () => {
    describe("on pause_campaign (cannot downsize)", () => {
      it("vetoes when dollarImpactCents > cap", () => {
        const result = applyRules(
          [rule("pair_dollar_cap", { cents: 500 })],
          { ...BASE_CTX, actionKind: "pause_campaign", dollarImpactCents: 1000 },
        );
        expect(result.veto).toBe("exceeds merchant dollar cap");
        expect(result.cappedDollarCents).toBeUndefined();
      });

      it("does NOT veto when dollarImpactCents <= cap", () => {
        const result = applyRules(
          [rule("pair_dollar_cap", { cents: 1000 })],
          { ...BASE_CTX, actionKind: "pause_campaign", dollarImpactCents: 1000 },
        );
        expect(result.veto).toBeUndefined();
        expect(result.cappedDollarCents).toBeUndefined();
      });
    });

    describe("on reduce_campaign_budget (can downsize)", () => {
      it("returns cappedDollarCents (no veto) when dollarImpactCents > cap", () => {
        const result = applyRules(
          [rule("pair_dollar_cap", { cents: 500 })],
          { ...BASE_CTX, actionKind: "reduce_campaign_budget", dollarImpactCents: 1000 },
        );
        expect(result.veto).toBeUndefined();
        expect(result.cappedDollarCents).toBe(500);
      });

      it("returns no veto and no cap when dollarImpactCents <= cap", () => {
        const result = applyRules(
          [rule("pair_dollar_cap", { cents: 2000 })],
          { ...BASE_CTX, actionKind: "reduce_campaign_budget", dollarImpactCents: 1000 },
        );
        expect(result.veto).toBeUndefined();
        expect(result.cappedDollarCents).toBeUndefined();
      });
    });
  });

  describe("first-veto-wins ordering", () => {
    it("muted_pair wins over blackout + min_spend in a multi-rule set", () => {
      const rules = [
        rule("pair_blackout_hours", { hours: [14] }),
        rule("pair_min_spend", { cents: 100000 }),
        rule("muted_pair"),
      ];
      const result = applyRules(rules, { ...BASE_CTX, nowUtcHour: 14, campaignSpendCents: 10 });
      // muted_pair is priority 0 — must win
      expect(result.veto).toBe("merchant handles this");
    });

    it("pair_blackout_hours vetoes before pair_min_spend when both would veto", () => {
      const rules = [
        rule("pair_min_spend", { cents: 100000 }),
        rule("pair_blackout_hours", { hours: [14] }),
      ];
      const result = applyRules(rules, {
        ...BASE_CTX,
        nowUtcHour: 14,
        campaignSpendCents: 10,
      });
      // blackout is priority 2, min_spend is priority 3 — blackout wins
      expect(result.veto).toBe("outside merchant-allowed hours");
    });

    it("pair_dollar_cap on reduce returns cappedDollarCents even when blackout does NOT veto", () => {
      const rules = [
        rule("pair_blackout_hours", { hours: [12] }), // hour 14 not in list → no veto
        rule("pair_dollar_cap", { cents: 500 }),
      ];
      const result = applyRules(rules, {
        ...BASE_CTX,
        actionKind: "reduce_campaign_budget",
        nowUtcHour: 14,
        dollarImpactCents: 1000,
      });
      expect(result.veto).toBeUndefined();
      expect(result.cappedDollarCents).toBe(500);
    });
  });

  describe("pair_probation_until belt-and-suspenders", () => {
    it("vetoes an active probation (belt-and-suspenders, isGraduated already blocks graduation)", () => {
      const result = applyRules(
        [rule("pair_probation_until", { until: "2027-01-01T00:00:00.000Z" })],
        BASE_CTX,
      );
      expect(result.veto).toBeDefined();
    });
  });

  it("returns {} (no veto, no cap) when rules array is empty", () => {
    const result = applyRules([], BASE_CTX);
    expect(result).toEqual({});
  });

  it("skips unknown rule kinds (forward compatible)", () => {
    const result = applyRules(
      [rule("future_rule_kind_v2", { something: true })],
      BASE_CTX,
    );
    expect(result).toEqual({});
  });
});

// ─── loadPairRules ────────────────────────────────────────────────────────

describe("loadPairRules", () => {
  it("returns rows from Supabase on success", async () => {
    const fakeRules = [
      { rule_kind: "muted_pair", rule_value: {} },
    ];
    const sb = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        then: (resolve: (r: { data: unknown; error: null }) => unknown) =>
          resolve({ data: fakeRules, error: null }),
      }),
    } as unknown as SupabaseClient;

    const result = await loadPairRules("shop1", "campaign_below_breakeven", "pause_campaign", sb);
    expect(result).toEqual(fakeRules);
  });

  it("throws when Supabase returns an error", async () => {
    const sb = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        then: (resolve: (r: { data: null; error: { message: string } }) => unknown) =>
          resolve({ data: null, error: { message: "connection refused" } }),
      }),
    } as unknown as SupabaseClient;

    await expect(loadPairRules("shop1", "campaign_below_breakeven", "pause_campaign", sb)).rejects.toThrow(
      "calibration_rule load failed",
    );
  });

  it("returns [] when data is null (no rows)", async () => {
    const sb = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        then: (resolve: (r: { data: null; error: null }) => unknown) =>
          resolve({ data: null, error: null }),
      }),
    } as unknown as SupabaseClient;

    const result = await loadPairRules("shop1", "campaign_below_breakeven", "pause_campaign", sb);
    expect(result).toEqual([]);
  });
});

// ─── loadAndApplyRules ────────────────────────────────────────────────────

describe("loadAndApplyRules", () => {
  it("returns { veto: 'rules unavailable' } when loadPairRules throws", async () => {
    const sb = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        then: (resolve: (r: { data: null; error: { message: string } }) => unknown) =>
          resolve({ data: null, error: { message: "DB timeout" } }),
      }),
    } as unknown as SupabaseClient;

    const result = await loadAndApplyRules(
      "shop1",
      "campaign_below_breakeven",
      "pause_campaign",
      {
        dollarImpactCents: 1000,
        campaignSpendCents: 50000,
        nowUtcHour: 14,
        nowIso: "2026-06-21T14:00:00.000Z",
      },
      sb,
    );
    expect(result.veto).toBe("rules unavailable");
  });

  it("passes through applyRules result on a successful load with no active rules", async () => {
    const sb = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        then: (resolve: (r: { data: []; error: null }) => unknown) =>
          resolve({ data: [], error: null }),
      }),
    } as unknown as SupabaseClient;

    const result = await loadAndApplyRules(
      "shop1",
      "campaign_below_breakeven",
      "pause_campaign",
      {
        dollarImpactCents: 1000,
        campaignSpendCents: 50000,
        nowUtcHour: 14,
      },
      sb,
    );
    expect(result).toEqual({});
  });

  it("applies a muted_pair rule returned from the DB and returns a veto", async () => {
    const sb = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        then: (resolve: (r: { data: CalibrationRule[]; error: null }) => unknown) =>
          resolve({ data: [{ rule_kind: "muted_pair", rule_value: {} }], error: null }),
      }),
    } as unknown as SupabaseClient;

    const result = await loadAndApplyRules(
      "shop1",
      "campaign_below_breakeven",
      "pause_campaign",
      {
        dollarImpactCents: 1000,
        campaignSpendCents: 50000,
        nowUtcHour: 14,
      },
      sb,
    );
    expect(result.veto).toBe("merchant handles this");
  });
});

// ─── pair_mu_override (learned sizing restraint) ────────────────────────────

describe("applyRules pair_mu_override", () => {
  it("returns the clamped muOverride without vetoing", () => {
    const result = applyRules([rule("pair_mu_override", { mu: 0.7 })], BASE_CTX);
    expect(result.veto).toBeUndefined();
    expect(result.muOverride).toBe(0.7);
  });

  it("clamps out-of-range values to [0.05, 1]", () => {
    expect(applyRules([rule("pair_mu_override", { mu: -3 })], BASE_CTX).muOverride).toBe(0.05);
    expect(applyRules([rule("pair_mu_override", { mu: 7 })], BASE_CTX).muOverride).toBe(1);
  });

  it("ignores a rule with no numeric mu", () => {
    const result = applyRules([rule("pair_mu_override", {})], BASE_CTX);
    expect(result.muOverride).toBeUndefined();
    expect(result.veto).toBeUndefined();
  });

  it("resolves multiple active overrides to the TIGHTEST dial", () => {
    const result = applyRules(
      [rule("pair_mu_override", { mu: 0.85 }), rule("pair_mu_override", { mu: 0.55 })],
      BASE_CTX,
    );
    expect(result.muOverride).toBe(0.55);
  });

  it("combines with a reduce dollar cap: both effects returned, no veto", () => {
    const result = applyRules(
      [rule("pair_mu_override", { mu: 0.4 }), rule("pair_dollar_cap", { cents: 500 })],
      { ...BASE_CTX, actionKind: "reduce_campaign_budget", dollarImpactCents: 1000 },
    );
    expect(result.veto).toBeUndefined();
    expect(result.muOverride).toBe(0.4);
    expect(result.cappedDollarCents).toBe(500);
  });

  it("a veto rule still wins over sizing effects (mute beats override)", () => {
    const result = applyRules(
      [rule("pair_mu_override", { mu: 0.4 }), rule("muted_pair")],
      BASE_CTX,
    );
    expect(result.veto).toBe("merchant handles this");
    expect(result.muOverride).toBeUndefined();
  });

  it("resolves multiple reduce dollar caps to the tightest cap", () => {
    const result = applyRules(
      [rule("pair_dollar_cap", { cents: 900 }), rule("pair_dollar_cap", { cents: 300 })],
      { ...BASE_CTX, actionKind: "reduce_campaign_budget", dollarImpactCents: 1000 },
    );
    expect(result.cappedDollarCents).toBe(300);
  });
});
