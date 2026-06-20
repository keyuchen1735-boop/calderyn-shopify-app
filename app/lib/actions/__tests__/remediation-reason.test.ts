// app/lib/actions/__tests__/remediation-reason.test.ts
import { describe, it, expect } from "vitest";
import { remediationReason } from "../remediation-reason";
import type { RemediationPlan } from "../../remediation/types";

function plan(p: Partial<RemediationPlan>): RemediationPlan {
  return {
    moves: [
      { kind: "discontinue", dollarImpactCents: 400000, executor: "discontinue_sku", label: "Stop reordering this product" },
      { kind: "snooze", dollarImpactCents: 0, executor: "snooze_alert", label: "Snooze" },
    ],
    recommended: "discontinue",
    structurallyDead: true,
    ...p,
  };
}

describe("remediationReason", () => {
  it("names the recommended move, the structural verdict, and the projected dollars", () => {
    const s = remediationReason(plan({}), "discontinue", "negative_unit_economics");
    expect(s.toLowerCase()).toContain("discontinue");
    expect(s.toLowerCase()).toContain("structurally dead");
    expect(s).toContain("$4,000"); // 400000 cents → dollars
  });

  it("names the runner-up move and its dollars when one exists (ranked comparison)", () => {
    const s = remediationReason(
      plan({
        moves: [
          { kind: "reallocate_to_winner", dollarImpactCents: 530449, executor: "reallocate_spend_sku", label: "Move ad budget to a higher-margin product" },
          { kind: "cut_ads", dollarImpactCents: 420000, executor: "pause_campaign", label: "Cut the ad spend driving the loss" },
          { kind: "snooze", dollarImpactCents: 0, executor: "snooze_alert", label: "Snooze" },
        ],
        recommended: "reallocate_to_winner",
        structurallyDead: false,
      }),
      "reallocate_to_winner",
      "negative_unit_economics",
    );
    expect(s.toLowerCase()).toContain("reallocate_to_winner");
    expect(s).toContain("$5,304"); // recommended 530449c
    expect(s).toContain("cut_ads");
    expect(s).toContain("$4,200"); // runner-up 420000c
  });

  it("omits the comparison clause when the only other move is snooze", () => {
    const s = remediationReason(plan({}), "discontinue", "negative_unit_economics");
    expect(s).not.toContain(" vs snooze");
  });

  it("is a non-empty single line (no newlines) for the audit column", () => {
    const s = remediationReason(plan({}), "discontinue", "cogs_drift");
    expect(s.length).toBeGreaterThan(0);
    expect(s).not.toContain("\n");
  });
});
