// app/lib/remediation/__tests__/rank.test.ts
import { describe, it, expect } from "vitest";
import { rankMoves, toNumericEvidence } from "../rank";
import type { RemediationInput } from "../types";

function input(p: Partial<RemediationInput>): RemediationInput {
  return {
    detectorId: "negative_unit_economics",
    dollarImpactCents: 530449,
    evidence: {},
    ...p,
  };
}

describe("rankMoves — ditch vs tune gate", () => {
  it("viable product bled by ads → recommends reallocate, NOT discontinue (the screenshot case)", () => {
    // Summit Logo Tee — M: +$23 gross margin, $170 CAC, -$147 net.
    const plan = rankMoves(
      input({
        detectorId: "negative_unit_economics",
        evidence: { gross_unit_margin_usd: 23, cac_per_unit_usd: 170, net_per_unit_usd: -147 },
      }),
    );
    expect(plan.structurallyDead).toBe(false);
    expect(plan.recommended).toBe("reallocate_to_winner");
    expect(plan.moves.map((m) => m.kind)).toContain("cut_ads");
    expect(plan.moves.map((m) => m.kind)).not.toContain("discontinue");
  });

  it("structurally dead product (gross margin ≤ 0) → recommends discontinue, not ad moves", () => {
    const plan = rankMoves(
      input({
        detectorId: "negative_unit_economics",
        evidence: { gross_unit_margin_usd: -4, cac_per_unit_usd: 30, net_per_unit_usd: -34 },
      }),
    );
    expect(plan.structurallyDead).toBe(true);
    expect(plan.recommended).toBe("discontinue");
    expect(plan.moves.map((m) => m.kind)).not.toContain("cut_ads");
    expect(plan.moves.map((m) => m.kind)).not.toContain("reallocate_to_winner");
  });

  it("always appends snooze last, and snooze is the only executable move in Phase 1", () => {
    const plan = rankMoves(input({ evidence: { gross_unit_margin_usd: 23, cac_per_unit_usd: 170 } }));
    expect(plan.moves[plan.moves.length - 1].kind).toBe("snooze");
    const executable = plan.moves.filter((m) => m.executor !== null);
    expect(executable.map((m) => m.kind)).toEqual(["snooze"]);
  });

  it("toNumericEvidence coerces strings and drops non-numerics to null", () => {
    expect(toNumericEvidence({ a: "23", b: 170, c: "x", d: null })).toEqual({
      a: 23,
      b: 170,
      c: null,
      d: null,
    });
  });
});

describe("rankMoves — returns, margin, cogs", () => {
  it("return_rate_hidden_loss → recommends fix_returns, scored by 30d return dollars", () => {
    const plan = rankMoves(
      input({
        detectorId: "return_rate_hidden_loss",
        dollarImpactCents: 100000,
        evidence: { unit_margin_usd: 12, return_rate: 0.31, return_30d_usd: 1800 },
      }),
    );
    expect(plan.recommended).toBe("fix_returns");
    const fix = plan.moves.find((m) => m.kind === "fix_returns")!;
    expect(fix.dollarImpactCents).toBe(180000); // 1800 USD → cents
    // fix_returns has no executor and is never enriched — it must still carry a
    // reason so it never renders as a bare label (rule 12).
    expect(fix.executor).toBeNull();
    expect(fix.ineligibleReason).toBeTruthy();
  });

  it("ad_tax_overload with positive 7d gross profit → ad moves (reallocate recommended)", () => {
    const plan = rankMoves(
      input({
        detectorId: "ad_tax_overload",
        evidence: { gross_profit_7d_usd: 900, ad_tax_ratio: 0.62, ad_spend_7d_usd: 1400, revenue_7d_usd: 2200 },
      }),
    );
    expect(plan.structurallyDead).toBe(false);
    expect(plan.recommended).toBe("reallocate_to_winner");
  });

  it("ad_tax_overload with negative 7d gross profit → structurally dead → discontinue", () => {
    const plan = rankMoves(
      input({ detectorId: "ad_tax_overload", evidence: { gross_profit_7d_usd: -120 } }),
    );
    expect(plan.structurallyDead).toBe(true);
    expect(plan.recommended).toBe("discontinue");
  });

  it("margin_erosion still profitable → recommends review_pricing", () => {
    const plan = rankMoves(
      input({
        detectorId: "margin_erosion",
        evidence: { baseline_unit_margin_usd: 18, current_unit_margin_usd: 7, drop_pct: 61 },
      }),
    );
    expect(plan.recommended).toBe("review_pricing");
  });

  it("margin_erosion gone negative → discontinue overrides review_pricing", () => {
    const plan = rankMoves(
      input({ detectorId: "margin_erosion", evidence: { current_unit_margin_usd: -2 } }),
    );
    expect(plan.recommended).toBe("discontinue");
    expect(plan.structurallyDead).toBe(true);
  });

  it("cogs_drift still profitable → review_pricing", () => {
    const plan = rankMoves(
      input({
        detectorId: "cogs_drift",
        evidence: { prior_unit_cost_usd: 9, current_unit_cost_usd: 13, drift_pct: 44, gross_profit_7d_usd: 400 },
      }),
    );
    expect(plan.recommended).toBe("review_pricing");
  });
});

describe("rankMoves — executors (Phase 2)", () => {
  it("the discontinue move carries the discontinue_sku executor", () => {
    const plan = rankMoves(
      input({
        detectorId: "negative_unit_economics",
        evidence: { gross_unit_margin_usd: -4, cac_per_unit_usd: 30, net_per_unit_usd: -34 },
      }),
    );
    const discontinue = plan.moves.find((m) => m.kind === "discontinue")!;
    expect(discontinue).toBeDefined();
    expect(discontinue.executor).toBe("discontinue_sku");
  });

  it("non-discontinue moves stay advisory (executor null), snooze stays snooze_alert", () => {
    const plan = rankMoves(
      input({
        detectorId: "negative_unit_economics",
        evidence: { gross_unit_margin_usd: 23, cac_per_unit_usd: 170, net_per_unit_usd: -147 },
      }),
    );
    const cut = plan.moves.find((m) => m.kind === "cut_ads")!;
    const realloc = plan.moves.find((m) => m.kind === "reallocate_to_winner")!;
    const snooze = plan.moves.find((m) => m.kind === "snooze")!;
    expect(cut.executor).toBeNull();
    expect(realloc.executor).toBeNull();
    expect(snooze.executor).toBe("snooze_alert");
  });
});
