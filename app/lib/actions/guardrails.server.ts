// Load a shop's guardrail config + live counts, then evaluate. Translates the DB
// row (dollars, ints) into the pure evaluator's shape.

import type { SupabaseClient } from "@supabase/supabase-js";
import { isUuid } from "../ids";
import { evaluateGuardrails, type AutopilotGuardrails, type GuardrailResult, type GuardedKind } from "./guardrails";

export interface CheckInput {
  kind: GuardedKind;
  campaignId: string;
  /** Set for reallocate_budget — enables the dest-side cooldown check. */
  destCampaignId?: string;
  dollarImpactCents: number;
  campaignSpendCents: number;
  currentBudgetCents?: number;
  newBudgetCents?: number;
}

async function minutesSinceLastAutopilotActionOn(
  sb: SupabaseClient,
  shopId: string,
  campaignId: string,
): Promise<number | null> {
  // Matches the campaign as the single-campaign target (params.campaign_id —
  // also written by reallocations for their SOURCE) OR as a reallocation
  // DESTINATION (params.dest_campaign_id). Intent: a campaign that just
  // RECEIVED budget was touched — pausing or cutting it seconds later would
  // be autopilot whiplash, so it cools down like any other recent target.
  const { data: last } = await sb
    .from("action_audit")
    .select("created_at")
    .eq("shop_id", shopId)
    .eq("actor_user_id", "autopilot")
    .or(`params->>campaign_id.eq.${campaignId},params->>dest_campaign_id.eq.${campaignId}`)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return last?.created_at ? (Date.now() - Date.parse(String(last.created_at))) / 60000 : null;
}

function startOfUtcDayIso(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

export interface CheckGuardrailsOpts {
  /** Force bypass mode OFF regardless of the DB setting. Use for autonomous
   * (autopilot) calls so a bypass-enabled config never silently waives safety
   * gates on autonomous actions (I1). */
  forceBypassOff?: boolean;
  /** Mark this as an autonomous (autopilot) call. Affects null-cap treatment:
   * null dailyActionCap is treated as 5 (not unlimited) for autonomous calls. */
  autonomous?: boolean;
}

export async function checkGuardrails(
  shopId: string,
  input: CheckInput,
  sb: SupabaseClient,
  opts?: CheckGuardrailsOpts,
): Promise<GuardrailResult> {
  // Ids are interpolated into a PostgREST .or() filter — refuse anything that
  // is not a plain uuid rather than risk corrupting the filter expression.
  if (!isUuid(input.campaignId) || (input.destCampaignId && !isUuid(input.destCampaignId))) {
    return { allowed: false, reason: "invalid campaign id" };
  }

  const { data: row, error } = await sb
    .from("guardrail_config")
    .select(
      "autopilot_enabled, autopilot_bypass_guardrails, autopilot_daily_action_cap, autopilot_min_spend_cents, autopilot_max_budget_cut_pct, autopilot_max_budget_increase_pct, autopilot_max_daily_budget_cents, dollar_impact_cap_without_2fa, daily_action_budget, cooldown_minutes_per_campaign, business_hours_only, business_hours_start_utc, business_hours_end_utc, autopilot_max_price_change_pct, autopilot_max_inventory_units_per_move",
    )
    .eq("shop_id", shopId)
    .maybeSingle();
  if (error) throw error;
  if (!row) return { allowed: false, reason: "no guardrail config" };

  const config: AutopilotGuardrails = {
    enabled: Boolean(row.autopilot_enabled),
    // I1: bypass forced OFF for autonomous calls regardless of DB setting.
    bypassGuardrails: opts?.forceBypassOff ? false : Boolean(row.autopilot_bypass_guardrails),
    // null column = no daily cap (unlimited); otherwise the configured integer.
    dailyActionCap:
      row.autopilot_daily_action_cap == null ? null : Number(row.autopilot_daily_action_cap),
    minSpendCents: Number(row.autopilot_min_spend_cents ?? 0),
    maxBudgetCutPct: Number(row.autopilot_max_budget_cut_pct ?? 0),
    maxBudgetIncreasePct: Number(row.autopilot_max_budget_increase_pct ?? 20),
    maxDailyBudgetCents:
      row.autopilot_max_daily_budget_cents == null ? null : Number(row.autopilot_max_daily_budget_cents),
    dollarCapCents: Math.round(Number(row.dollar_impact_cap_without_2fa ?? 0) * 100),
    // daily_action_budget stored in DOLLARS in DB; convert to cents for evaluator.
    dailyActionBudgetCents:
      row.daily_action_budget == null ? null : Math.round(Number(row.daily_action_budget) * 100),
    cooldownMinutes: Number(row.cooldown_minutes_per_campaign ?? 0),
    businessHoursOnly: Boolean(row.business_hours_only),
    businessHoursStartUtc: Number(row.business_hours_start_utc ?? 0),
    businessHoursEndUtc: Number(row.business_hours_end_utc ?? 0),
    // Bounded-magnitude caps for autonomous price/inventory actions (§2.4).
    // Default 10% max price move; null inventory cap = unlimited (merchant opts in).
    maxPriceChangePct: Number(row.autopilot_max_price_change_pct ?? 10),
    maxInventoryUnitsPerMove:
      row.autopilot_max_inventory_units_per_move == null
        ? null
        : Number(row.autopilot_max_inventory_units_per_move),
  };

  // Count today's autopilot actions (UTC day). Only landed actions consume
  // the cap — a day of transient platform failures (`retrying`/`failed`)
  // must not exhaust it with zero actions actually taken.
  const { count } = await sb
    .from("action_audit")
    .select("id", { count: "exact", head: true })
    .eq("shop_id", shopId)
    .eq("actor_user_id", "autopilot")
    .eq("outcome", "succeeded")
    .gte("created_at", startOfUtcDayIso());

  // I2: sum today's autonomous dollar impact (DOLLARS in DB → cents here).
  // Only relevant for autonomous calls; merchant calls skip this query.
  let todayAutopilotDollarsCents: number | undefined;
  if (opts?.autonomous) {
    const { data: dollarRows } = await sb
      .from("action_audit")
      .select("dollar_impact_at_exec")
      .eq("shop_id", shopId)
      .eq("actor_user_id", "autopilot")
      .eq("outcome", "succeeded")
      .gte("created_at", startOfUtcDayIso());
    // dollar_impact_at_exec is stored in DOLLARS; convert to cents.
    todayAutopilotDollarsCents = (dollarRows ?? []).reduce(
      (sum, r) => sum + Math.round(Number(r.dollar_impact_at_exec ?? 0) * 100),
      0,
    );
  }

  const minutesSince = await minutesSinceLastAutopilotActionOn(sb, shopId, input.campaignId);
  const minutesSinceDest = input.destCampaignId
    ? await minutesSinceLastAutopilotActionOn(sb, shopId, input.destCampaignId)
    : null;

  return evaluateGuardrails(config, {
    kind: input.kind,
    dollarImpactCents: input.dollarImpactCents,
    campaignSpendCents: input.campaignSpendCents,
    currentBudgetCents: input.currentBudgetCents,
    newBudgetCents: input.newBudgetCents,
    todayAutopilotCount: count ?? 0,
    minutesSinceLastActionOnCampaign: minutesSince,
    minutesSinceLastActionOnDestCampaign: minutesSinceDest,
    nowUtcHour: new Date().getUTCHours(),
    todayAutopilotDollarsCents,
    autonomous: opts?.autonomous,
  });
}
