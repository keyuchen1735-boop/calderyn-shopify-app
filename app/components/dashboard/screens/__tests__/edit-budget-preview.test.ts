import { describe, expect, it } from "vitest";
import { budgetValidation, HIGH_BUDGET_CENTS } from "../edit-budget-preview";

describe("budgetValidation", () => {
  it("parses a plain dollar string into cents", () => {
    expect(budgetValidation("25", 0)).toEqual({
      cents: 2500,
      valid: true,
      changed: true,
      high: false,
    });
  });

  it("rejects empty input", () => {
    expect(budgetValidation("", 0)).toEqual({
      cents: 0,
      valid: false,
      changed: false,
      high: false,
    });
  });

  it("rejects zero and negative amounts", () => {
    expect(budgetValidation("0", 500).valid).toBe(false);
    expect(budgetValidation("-5", 500).valid).toBe(false);
  });

  it("rejects non-numeric input without throwing", () => {
    const result = budgetValidation("abc", 0);
    expect(result.valid).toBe(false);
    expect(Number.isNaN(result.cents)).toBe(true);
  });

  it("is not 'changed' when the amount matches the campaign's current budget", () => {
    expect(budgetValidation("25.00", 2500)).toEqual({
      cents: 2500,
      valid: true,
      changed: false,
      high: false,
    });
  });

  it("flags high only strictly above the threshold, not at it", () => {
    const atThreshold = budgetValidation((HIGH_BUDGET_CENTS / 100).toFixed(2), 0);
    expect(atThreshold.high).toBe(false);
    const overThreshold = budgetValidation((HIGH_BUDGET_CENTS / 100 + 0.01).toFixed(2), 0);
    expect(overThreshold.high).toBe(true);
  });
});
