import { describe, it, expect } from "vitest";
import { graduationProgress } from "../progress";

describe("graduationProgress", () => {
  it("reports both bars for a reversible action", () => {
    const p = graduationProgress("pause_campaign", 2, 1);
    expect(p).toEqual({
      approvals: 2, approvalsNeeded: 3, outcomes: 1, outcomesNeeded: 3, proven: false,
    });
  });

  it("is proven only when BOTH bars are met", () => {
    expect(graduationProgress("pause_campaign", 3, 3).proven).toBe(true);
    expect(graduationProgress("pause_campaign", 3, 2).proven).toBe(false);
    expect(graduationProgress("pause_campaign", 2, 3).proven).toBe(false);
  });

  it("uses the harder bars for hard_to_reverse kinds", () => {
    const p = graduationProgress("discontinue_sku", 0, 0);
    expect(p.approvalsNeeded).toBe(10);
    expect(p.outcomesNeeded).toBe(5);
  });
});
