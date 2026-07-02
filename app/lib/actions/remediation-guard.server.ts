// SKU-scoped guardrail check for autopilot remediation moves that act on a
// product rather than a campaign (e.g. discontinue_sku). The campaign guard
// (guardrails.server.ts) needs a campaignId for its cooldown .or() filter and
// reads campaign-budget facts; a SKU move has neither. This reuses the SHARED
// config + the same autopilot-action-cap count so a SKU action and a campaign
// action draw from one budget, but applies only the kind-agnostic rules:
// enabled, daily action cap, dollar cap, daily aggregate dollar ceiling,
// business hours. No new guardrail.
//
// Always autonomous: every caller is the autopilot tick, so the null-cap
// treatment (null = 5, not unlimited — I2) and the aggregate daily-dollar
// ceiling (I2) apply unconditionally, matching evaluateGuardrails semantics.
import type { SupabaseClient } from "@supabase/supabase-js";
import { withinBusinessHours, type GuardrailResult } from "./guardrails";
import {
  loadTodayAutopilotCount,
  loadTodayAutopilotDollarsCents,
} from "./guardrails.server";

export interface SkuCheckInput {
  /** Projected 30d recovery in cents — checked against the per-action dollar cap. */
  dollarImpactCents: number;
}

export async function checkSkuGuardrails(
  shopId: string,
  input: SkuCheckInput,
  sb: SupabaseClient,
): Promise<GuardrailResult> {
  const { data: row, error } = await sb
    .from("guardrail_config")
    .select(
      "autopilot_enabled, autopilot_daily_action_cap, dollar_impact_cap_without_2fa, daily_action_budget, business_hours_only, business_hours_start_utc, business_hours_end_utc",
    )
    .eq("shop_id", shopId)
    .maybeSingle();
  if (error) throw error;
  if (!row) return { allowed: false, reason: "no guardrail config" };

  if (!row.autopilot_enabled) return { allowed: false, reason: "auto-pilot disabled" };

  // I2: a null daily action cap is 5 for autonomous calls — never unlimited,
  // and never 0 (a 0 default would permanently brick SKU autonomy).
  const dailyActionCap =
    row.autopilot_daily_action_cap == null ? 5 : Number(row.autopilot_daily_action_cap);
  const dollarCapCents = Math.round(Number(row.dollar_impact_cap_without_2fa ?? 0) * 100);

  // Same cap accounting as the campaign guard: only landed (`succeeded`)
  // autopilot actions for today (UTC) consume the cap.
  const count = await loadTodayAutopilotCount(shopId, sb);
  if (count >= dailyActionCap) return { allowed: false, reason: "daily action cap reached" };

  if (input.dollarImpactCents > dollarCapCents) {
    return { allowed: false, reason: "dollar impact exceeds cap" };
  }

  // I2: aggregate daily-dollar ceiling — today's autonomous impact plus this
  // action may not exceed daily_action_budget (stored in DOLLARS in the DB).
  const dailyActionBudgetCents =
    row.daily_action_budget == null ? null : Math.round(Number(row.daily_action_budget) * 100);
  if (dailyActionBudgetCents != null) {
    const todayDollarsCents = await loadTodayAutopilotDollarsCents(shopId, sb);
    if (todayDollarsCents + input.dollarImpactCents > dailyActionBudgetCents) {
      return { allowed: false, reason: "daily dollar ceiling reached" };
    }
  }

  if (
    row.business_hours_only &&
    !withinBusinessHours(
      Number(row.business_hours_start_utc ?? 0),
      Number(row.business_hours_end_utc ?? 0),
      new Date().getUTCHours(),
    )
  ) {
    return { allowed: false, reason: "outside business hours" };
  }

  return { allowed: true };
}
