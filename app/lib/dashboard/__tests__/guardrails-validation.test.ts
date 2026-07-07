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

  it("rejects a zero or non-integer budget-cut percentage (must be 1..100)", () => {
    expect(validateGuardrailPatch({ autopilot_max_budget_cut_pct: 0 })).not.toBeNull();
    expect(validateGuardrailPatch({ autopilot_max_budget_cut_pct: 12.5 })).not.toBeNull();
  });

  it("accepts a custom in-range budget-cut percentage", () => {
    expect(validateGuardrailPatch({ autopilot_max_budget_cut_pct: 37 })).toBeNull();
  });

  it("bounds the adjust_price max_price_change_pct to a whole 1..100", () => {
    expect(validateGuardrailPatch({ max_price_change_pct: 15 })).toBeNull();
    expect(validateGuardrailPatch({ max_price_change_pct: 0 })).not.toBeNull();
    expect(validateGuardrailPatch({ max_price_change_pct: 250 })).not.toBeNull();
    expect(validateGuardrailPatch({ max_price_change_pct: 12.5 })).not.toBeNull();
  });

  it("rejects a zero or non-integer budget-increase percentage (must be 1..100)", () => {
    expect(validateGuardrailPatch({ autopilot_max_budget_increase_pct: 0 })).not.toBeNull();
    expect(validateGuardrailPatch({ autopilot_max_budget_increase_pct: 7.5 })).not.toBeNull();
  });

  it("rejects a non-integer or negative daily action cap", () => {
    expect(validateGuardrailPatch({ autopilot_daily_action_cap: -1 })).not.toBeNull();
    expect(validateGuardrailPatch({ autopilot_daily_action_cap: 2.5 })).not.toBeNull();
    // 0 is not a meaningful cap (it would block every action); reject it so the
    // only way to express "no cap" is an explicit null.
    expect(validateGuardrailPatch({ autopilot_daily_action_cap: 0 })).not.toBeNull();
  });

  it("accepts a null daily action cap (unlimited)", () => {
    expect(validateGuardrailPatch({ autopilot_daily_action_cap: null })).toBeNull();
  });

  it("accepts a custom positive integer daily action cap", () => {
    expect(validateGuardrailPatch({ autopilot_daily_action_cap: 25 })).toBeNull();
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

  it("rejects an out-of-range increase pct", () => {
    expect(validateGuardrailPatch({ autopilot_max_budget_increase_pct: 999 })).not.toBeNull();
    expect(validateGuardrailPatch({ autopilot_max_budget_increase_pct: -1 })).not.toBeNull();
  });
  it("accepts a valid increase pct and a null ceiling", () => {
    expect(validateGuardrailPatch({ autopilot_max_budget_increase_pct: 20, autopilot_max_daily_budget_cents: null })).toBeNull();
  });
  it("rejects a negative daily ceiling", () => {
    expect(validateGuardrailPatch({ autopilot_max_daily_budget_cents: -100 })).not.toBeNull();
  });

  it("accepts a valid autopilot price cap", () => {
    expect(validateGuardrailPatch({ autopilot_max_price_change_pct: 10 })).toBeNull();
  });

  it("rejects an out-of-range autopilot price cap (above 100)", () => {
    expect(validateGuardrailPatch({ autopilot_max_price_change_pct: 150 })).toBe(
      "invalid_autopilot_max_price_change_pct",
    );
  });

  it("rejects a zero autopilot price cap (must be 1..100)", () => {
    expect(validateGuardrailPatch({ autopilot_max_price_change_pct: 0 })).toBe(
      "invalid_autopilot_max_price_change_pct",
    );
  });

  it("accepts null as the inventory units cap (unlimited)", () => {
    expect(validateGuardrailPatch({ autopilot_max_inventory_units_per_move: null })).toBeNull();
  });

  it("accepts a positive integer inventory units cap", () => {
    expect(validateGuardrailPatch({ autopilot_max_inventory_units_per_move: 50 })).toBeNull();
  });

  it("rejects zero for the inventory units cap", () => {
    expect(validateGuardrailPatch({ autopilot_max_inventory_units_per_move: 0 })).toBe(
      "invalid_autopilot_max_inventory_units_per_move",
    );
  });

  it("rejects a negative inventory units cap", () => {
    expect(validateGuardrailPatch({ autopilot_max_inventory_units_per_move: -5 })).toBe(
      "invalid_autopilot_max_inventory_units_per_move",
    );
  });

  it("ignores keys not present in the patch", () => {
    expect(validateGuardrailPatch({})).toBeNull();
  });

  it("validates budget/cap/cooldown (moved in from the route)", () => {
    expect(validateGuardrailPatch({ daily_action_budget_cents: 0 })).not.toBeNull();
    expect(validateGuardrailPatch({ dollar_cap_cents: -100 })).not.toBeNull();
    expect(validateGuardrailPatch({ daily_action_budget_cents: "lots" as unknown as number })).not.toBeNull();
    expect(validateGuardrailPatch({ cooldown_minutes: -5 })).not.toBeNull();
    expect(validateGuardrailPatch({ cooldown_minutes: 0 })).toBeNull();
    expect(validateGuardrailPatch({ daily_action_budget_cents: 75_000, dollar_cap_cents: 20_000 })).toBeNull();
  });

  it("rejects values above the sanity ceilings", () => {
    expect(validateGuardrailPatch({ daily_action_budget_cents: 100_000_001 })).not.toBeNull();
    expect(validateGuardrailPatch({ dollar_cap_cents: 100_000_001 })).not.toBeNull();
    expect(validateGuardrailPatch({ cooldown_minutes: 10_081 })).not.toBeNull();
    expect(validateGuardrailPatch({ autopilot_min_spend_cents: 100_000_001 })).not.toBeNull();
    expect(validateGuardrailPatch({ autopilot_max_daily_budget_cents: 100_000_001 })).not.toBeNull();
  });

  it("requires business_hours start/end to be whole HH:00 and a real timezone", () => {
    expect(validateGuardrailPatch({ business_hours: { start: "09:30", end: "17:00", tz: "America/New_York" } as never })).not.toBeNull();
    expect(validateGuardrailPatch({ business_hours: { start: "9:00", end: "17:00", tz: "America/New_York" } as never })).not.toBeNull();
    expect(validateGuardrailPatch({ business_hours: { start: "09:00", end: "17:00", tz: "Mars/Phobos" } as never })).not.toBeNull();
    expect(validateGuardrailPatch({ business_hours: { start: "09:00", end: "17:00", tz: "America/New_York" } as never })).toBeNull();
  });

  it("validates autopilot_bypass_guardrails as a boolean", () => {
    expect(validateGuardrailPatch({ autopilot_bypass_guardrails: true })).toBeNull();
    expect(validateGuardrailPatch({ autopilot_bypass_guardrails: false })).toBeNull();
    expect(
      validateGuardrailPatch({ autopilot_bypass_guardrails: "yes" as unknown as boolean }),
    ).not.toBeNull();
  });

  it("validates business_hours_only as a boolean", () => {
    expect(validateGuardrailPatch({ business_hours_only: true })).toBeNull();
    expect(validateGuardrailPatch({ business_hours_only: "yes" as unknown as boolean })).not.toBeNull();
  });

  it("weather_sensitivity: whole-percent 0..100, 0 allowed (feature off)", () => {
    expect(validateGuardrailPatch({ weather_sensitivity: 0 })).toBeNull();
    expect(validateGuardrailPatch({ weather_sensitivity: 50 })).toBeNull();
    expect(validateGuardrailPatch({ weather_sensitivity: 100 })).toBeNull();
    expect(validateGuardrailPatch({ weather_sensitivity: -1 })).toBe("invalid_weather_sensitivity");
    expect(validateGuardrailPatch({ weather_sensitivity: 101 })).toBe("invalid_weather_sensitivity");
    expect(validateGuardrailPatch({ weather_sensitivity: 12.5 })).toBe("invalid_weather_sensitivity");
    expect(validateGuardrailPatch({ weather_sensitivity: NaN })).toBe("invalid_weather_sensitivity");
  });

  it("merchant location: valid coordinate pair, or null pair to clear", () => {
    expect(validateGuardrailPatch({ merchant_lat: 47.61, merchant_lon: -122.33 })).toBeNull();
    expect(validateGuardrailPatch({ merchant_lat: null, merchant_lon: null })).toBeNull();
  });

  it("merchant location: rejects out-of-range, NaN, and a half-set pair", () => {
    expect(validateGuardrailPatch({ merchant_lat: 91, merchant_lon: 0 })).toBe("invalid_merchant_location");
    expect(validateGuardrailPatch({ merchant_lat: 0, merchant_lon: -181 })).toBe("invalid_merchant_location");
    expect(validateGuardrailPatch({ merchant_lat: NaN, merchant_lon: 0 })).toBe("invalid_merchant_location");
    // Lat without lon (and vice versa) is meaningless — reject rather than store half a location.
    expect(validateGuardrailPatch({ merchant_lat: 47.61 })).toBe("invalid_merchant_location");
    expect(validateGuardrailPatch({ merchant_lon: -122.33 })).toBe("invalid_merchant_location");
    expect(validateGuardrailPatch({ merchant_lat: 47.61, merchant_lon: null })).toBe("invalid_merchant_location");
  });
});
