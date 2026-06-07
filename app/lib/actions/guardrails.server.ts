// Load a shop's guardrail config + live counts, then evaluate. Translates the DB
// row (dollars, ints) into the pure evaluator's shape.

import type { SupabaseClient } from "@supabase/supabase-js";
import { evaluateGuardrails, type AutopilotGuardrails, type GuardrailResult } from "./guardrails";
import type { ExecutableKind } from "./execute.server";

export interface CheckInput {
  kind: ExecutableKind;
  campaignId: string;
  dollarImpactCents: number;
  campaignSpendCents: number;
  currentBudgetCents?: number;
  newBudgetCents?: number;
}

function startOfUtcDayIso(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

export async function checkGuardrails(
  shopId: string,
  input: CheckInput,
  sb: SupabaseClient,
): Promise<GuardrailResult> {
  const { data: row, error } = await sb
    .from("guardrail_config")
    .select(
      "autopilot_enabled, autopilot_daily_action_cap, autopilot_min_spend_cents, autopilot_max_budget_cut_pct, dollar_impact_cap_without_2fa, cooldown_minutes_per_campaign, business_hours_only, business_hours_start_utc, business_hours_end_utc",
    )
    .eq("shop_id", shopId)
    .maybeSingle();
  if (error) throw error;
  if (!row) return { allowed: false, reason: "no guardrail config" };

  const config: AutopilotGuardrails = {
    enabled: Boolean(row.autopilot_enabled),
    dailyActionCap: Number(row.autopilot_daily_action_cap ?? 0),
    minSpendCents: Number(row.autopilot_min_spend_cents ?? 0),
    maxBudgetCutPct: Number(row.autopilot_max_budget_cut_pct ?? 0),
    dollarCapCents: Math.round(Number(row.dollar_impact_cap_without_2fa ?? 0) * 100),
    cooldownMinutes: Number(row.cooldown_minutes_per_campaign ?? 0),
    businessHoursOnly: Boolean(row.business_hours_only),
    businessHoursStartUtc: Number(row.business_hours_start_utc ?? 0),
    businessHoursEndUtc: Number(row.business_hours_end_utc ?? 0),
  };

  // Count today's autopilot actions (UTC day).
  const { count } = await sb
    .from("action_audit")
    .select("id", { count: "exact", head: true })
    .eq("shop_id", shopId)
    .eq("actor_user_id", "autopilot")
    .gte("created_at", startOfUtcDayIso());

  // Most recent autopilot action on this campaign (for cooldown).
  const { data: last } = await sb
    .from("action_audit")
    .select("created_at")
    .eq("shop_id", shopId)
    .eq("actor_user_id", "autopilot")
    .eq("params->>campaign_id", input.campaignId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const minutesSince = last?.created_at
    ? (Date.now() - Date.parse(String(last.created_at))) / 60000
    : null;

  return evaluateGuardrails(config, {
    kind: input.kind,
    dollarImpactCents: input.dollarImpactCents,
    campaignSpendCents: input.campaignSpendCents,
    currentBudgetCents: input.currentBudgetCents,
    newBudgetCents: input.newBudgetCents,
    todayAutopilotCount: count ?? 0,
    minutesSinceLastActionOnCampaign: minutesSince,
    nowUtcHour: new Date().getUTCHours(),
  });
}
