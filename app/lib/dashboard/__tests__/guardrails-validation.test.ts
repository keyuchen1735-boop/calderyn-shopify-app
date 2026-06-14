// The guardrails PUT endpoint persists autopilot limits the autopilot executor
// later trusts. Before this, only daily_action_budget/dollar_cap/cooldown were
// validated; the autopilot fields and business_hours flowed through unchecked,
// so e.g. {autopilot_max_budget_cut_pct: 999} or a negative cap would persist
// and let autopilot slash budgets far past the intended ceiling. These tests
// lock the bounds.

import { describe, it, expect } from "vitest";
import { validateGuardrailPatch } from "../guardrails-validation";

describe("validateGuardrailPatch", () => {
  it("accepts a valid partial patch", () => {
    expect(
      validateGuardrailPatch({
        autopilot_enabled: true,
        autopilot_daily_action_cap: 5,
        autopilot_min_spend_cents: 1000,
        autopilot_max_budget_cut_pct: 30,
      }),
    ).toBeNull();
  });

  it("rejects a budget-cut percentage above 100", () => {
    expect(validateGuardrailPatch({ autopilot_max_budget_cut_pct: 999 })).not.toBeNull();
  });

  it("rejects a negative budget-cut percentage", () => {
    expect(validateGuardrailPatch({ autopilot_max_budget_cut_pct: -1 })).not.toBeNull();
  });

  it("rejects a non-integer or negative daily action cap", () => {
    expect(validateGuardrailPatch({ autopilot_daily_action_cap: -1 })).not.toBeNull();
    expect(validateGuardrailPatch({ autopilot_daily_action_cap: 2.5 })).not.toBeNull();
  });

  it("rejects a negative min spend", () => {
    expect(validateGuardrailPatch({ autopilot_min_spend_cents: -100 })).not.toBeNull();
  });

  it("rejects non-numeric autopilot values", () => {
    expect(
      validateGuardrailPatch({ autopilot_max_budget_cut_pct: "30" as unknown as number }),
    ).not.toBeNull();
    expect(
      validateGuardrailPatch({ autopilot_daily_action_cap: NaN }),
    ).not.toBeNull();
  });

  it("rejects autopilot_enabled that is not a boolean", () => {
    expect(
      validateGuardrailPatch({ autopilot_enabled: "yes" as unknown as boolean }),
    ).not.toBeNull();
  });

  it("rejects a malformed business_hours shape", () => {
    expect(
      validateGuardrailPatch({ business_hours: { start: "09:00" } as never }),
    ).not.toBeNull();
  });

  it("accepts a well-formed business_hours object", () => {
    expect(
      validateGuardrailPatch({
        business_hours: { start: "09:00", end: "17:00", tz: "America/New_York" } as never,
      }),
    ).toBeNull();
  });

  it("ignores keys not present in the patch", () => {
    expect(validateGuardrailPatch({})).toBeNull();
  });
});
