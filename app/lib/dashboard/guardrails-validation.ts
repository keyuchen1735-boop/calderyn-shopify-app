// Pure validation for the autopilot / business-hours fields of a guardrail
// patch. Kept server-free so it's unit-testable and importable from the route.
//
// These values are persisted to guardrail_config and later trusted by the
// autopilot executor, so out-of-range input (e.g. a 999% budget-cut, a negative
// cap, a NaN) must be rejected at the API boundary — not silently stored.

import type { GuardrailConfig } from "~/lib/types";

const isFiniteNum = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

const MONEY_CAP_CENTS = 100_000_000; // $1,000,000 — fat-finger ceiling, not a product limit
const COOLDOWN_MAX_MIN = 10_080; // 1 week
const HHMM_WHOLE_HOUR = /^([01]\d|2[0-3]):00$/;

function isValidTimeZone(tz: unknown): boolean {
  if (typeof tz !== "string" || tz.length === 0) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns an error code string when the patch is invalid, or null when every
 * present key is in range. Only validates keys actually present (partial patch).
 */
export function validateGuardrailPatch(patch: Partial<GuardrailConfig>): string | null {
  if ("daily_action_budget_cents" in patch) {
    const v = patch.daily_action_budget_cents;
    if (!isFiniteNum(v) || v <= 0 || v > MONEY_CAP_CENTS) return "invalid_daily_action_budget_cents";
  }

  if ("dollar_cap_cents" in patch) {
    const v = patch.dollar_cap_cents;
    if (!isFiniteNum(v) || v <= 0 || v > MONEY_CAP_CENTS) return "invalid_dollar_cap_cents";
  }

  if ("cooldown_minutes" in patch) {
    const v = patch.cooldown_minutes;
    if (!isFiniteNum(v) || v < 0 || v > COOLDOWN_MAX_MIN) return "invalid_cooldown_minutes";
  }

  if ("autopilot_enabled" in patch && typeof patch.autopilot_enabled !== "boolean") {
    return "invalid_autopilot_enabled";
  }

  if ("autopilot_bypass_guardrails" in patch && typeof patch.autopilot_bypass_guardrails !== "boolean") {
    return "invalid_autopilot_bypass_guardrails";
  }

  if ("autopilot_daily_action_cap" in patch) {
    const v = patch.autopilot_daily_action_cap;
    // null = "no cap" (unlimited) is valid; otherwise a positive integer 1..100.
    // 0 is rejected — a zero cap would silently block every autopilot action;
    // the only way to express "no cap" is an explicit null.
    if (v !== null && (!isFiniteNum(v) || !Number.isInteger(v) || v < 1 || v > 100)) {
      return "invalid_autopilot_daily_action_cap";
    }
  }

  if ("autopilot_min_spend_cents" in patch) {
    const v = patch.autopilot_min_spend_cents;
    if (!isFiniteNum(v) || v < 0 || v > MONEY_CAP_CENTS) return "invalid_autopilot_min_spend_cents";
  }

  if ("autopilot_max_budget_cut_pct" in patch) {
    const v = patch.autopilot_max_budget_cut_pct;
    // Custom entry is a whole-percent 1..100 — a 0% cut is a no-op rule.
    if (!isFiniteNum(v) || !Number.isInteger(v) || v < 1 || v > 100) {
      return "invalid_autopilot_max_budget_cut_pct";
    }
  }

  if ("autopilot_max_budget_increase_pct" in patch) {
    const v = patch.autopilot_max_budget_increase_pct;
    // Custom entry is a whole-percent 1..100 — a 0% increase is a no-op rule.
    if (!isFiniteNum(v) || !Number.isInteger(v) || v < 1 || v > 100) {
      return "invalid_autopilot_max_budget_increase_pct";
    }
  }

  if ("autopilot_max_daily_budget_cents" in patch) {
    const v = patch.autopilot_max_daily_budget_cents;
    // null = "no ceiling" is valid; otherwise a non-negative finite number within the cap.
    if (v !== null && (!isFiniteNum(v) || v < 0 || v > MONEY_CAP_CENTS)) {
      return "invalid_autopilot_max_daily_budget_cents";
    }
  }

  if ("max_price_change_pct" in patch) {
    const v = patch.max_price_change_pct;
    // Whole-percent 1..100 — a 0% change is a no-op rule. Gates the merchant
    // adjust_price action (confirm-only), so a fat-finger 999% is rejected here.
    if (!isFiniteNum(v) || !Number.isInteger(v) || v < 1 || v > 100) {
      return "invalid_max_price_change_pct";
    }
  }

  if ("autopilot_max_price_change_pct" in patch) {
    const v = patch.autopilot_max_price_change_pct;
    // Whole-percent 1..100 — mirrors max_price_change_pct but gates autopilot's
    // autonomous adjust_price path. A 0% move is a no-op; reject for clarity.
    if (!isFiniteNum(v) || !Number.isInteger(v) || v < 1 || v > 100) {
      return "invalid_autopilot_max_price_change_pct";
    }
  }

  if ("autopilot_max_inventory_units_per_move" in patch) {
    const v = patch.autopilot_max_inventory_units_per_move;
    // null = no cap (unlimited) is valid; otherwise a positive integer up to
    // 1_000_000. Zero is rejected — a zero cap silently blocks every move;
    // the only way to express "no cap" is an explicit null.
    if (v !== null && (!isFiniteNum(v) || !Number.isInteger(v) || v < 1 || v > 1_000_000)) {
      return "invalid_autopilot_max_inventory_units_per_move";
    }
  }

  if ("weather_sensitivity" in patch) {
    const v = patch.weather_sensitivity;
    // Whole-percent 0..100. Unlike the autopilot caps, 0 is VALID — it means the
    // weather-reallocation feature is OFF (the opt-in default). Reject negatives,
    // non-integers, out-of-range, and NaN at the boundary.
    if (!isFiniteNum(v) || !Number.isInteger(v) || v < 0 || v > 100) {
      return "invalid_weather_sensitivity";
    }
  }

  if ("business_hours_only" in patch && typeof patch.business_hours_only !== "boolean") {
    return "invalid_business_hours_only";
  }

  if ("business_hours" in patch) {
    const bh = patch.business_hours as unknown as Record<string, unknown> | null;
    const start = bh?.start;
    const end = bh?.end;
    if (
      typeof bh !== "object" ||
      bh === null ||
      typeof start !== "string" ||
      typeof end !== "string" ||
      !HHMM_WHOLE_HOUR.test(start) ||
      !HHMM_WHOLE_HOUR.test(end) ||
      !isValidTimeZone(bh.tz)
    ) {
      return "invalid_business_hours";
    }
  }

  return null;
}
