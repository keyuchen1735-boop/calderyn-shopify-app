// Pure validation for the autopilot / business-hours fields of a guardrail
// patch. Kept server-free so it's unit-testable and importable from the route.
//
// These values are persisted to guardrail_config and later trusted by the
// autopilot executor, so out-of-range input (e.g. a 999% budget-cut, a negative
// cap, a NaN) must be rejected at the API boundary — not silently stored.

import type { GuardrailConfig } from "~/lib/types";

const isFiniteNum = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

/**
 * Returns an error code string when the patch is invalid, or null when every
 * present key is in range. Only validates keys actually present (partial patch).
 * The budget/cap/cooldown fields are validated separately in the route.
 */
export function validateGuardrailPatch(patch: Partial<GuardrailConfig>): string | null {
  if ("autopilot_enabled" in patch && typeof patch.autopilot_enabled !== "boolean") {
    return "invalid_autopilot_enabled";
  }

  if ("autopilot_daily_action_cap" in patch) {
    const v = patch.autopilot_daily_action_cap;
    if (!isFiniteNum(v) || !Number.isInteger(v) || v < 0 || v > 100) {
      return "invalid_autopilot_daily_action_cap";
    }
  }

  if ("autopilot_min_spend_cents" in patch) {
    const v = patch.autopilot_min_spend_cents;
    if (!isFiniteNum(v) || v < 0) return "invalid_autopilot_min_spend_cents";
  }

  if ("autopilot_max_budget_cut_pct" in patch) {
    const v = patch.autopilot_max_budget_cut_pct;
    if (!isFiniteNum(v) || v < 0 || v > 100) return "invalid_autopilot_max_budget_cut_pct";
  }

  if ("business_hours" in patch) {
    const bh = patch.business_hours as unknown;
    const field = (k: string) =>
      typeof (bh as Record<string, unknown>)?.[k] === "string";
    if (typeof bh !== "object" || bh === null || !field("start") || !field("end") || !field("tz")) {
      return "invalid_business_hours";
    }
  }

  return null;
}
