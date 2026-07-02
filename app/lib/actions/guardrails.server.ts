// Load a shop's guardrail config + live counts, then evaluate. Translates the DB
// row (dollars, ints) into the pure evaluator's shape.

import type { SupabaseClient } from "@supabase/supabase-js";
import { isUuid } from "../ids";
import { evaluateGuardrails, type AutopilotGuardrails, type GuardrailResult, type GuardedKind } from "./guardrails";

/** Raw guardrail_config columns read from the DB, shared between check functions. */
type ConfigRow = {
  autopilot_enabled: unknown;
  autopilot_bypass_guardrails: unknown;
  autopilot_daily_action_cap: unknown;
  autopilot_min_spend_cents: unknown;
  autopilot_max_budget_cut_pct: unknown;
  autopilot_max_budget_increase_pct: unknown;
  autopilot_max_daily_budget_cents: unknown;
  dollar_impact_cap_without_2fa: unknown;
  daily_action_budget: unknown;
  cooldown_minutes_per_campaign: unknown;
  business_hours_only: unknown;
  business_hours_start_utc: unknown;
  business_hours_end_utc: unknown;
  autopilot_max_price_change_pct: unknown;
  autopilot_max_inventory_units_per_move: unknown;
};

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

/** Load and translate a guardrail_config row for a shop. Returns null when no
 * row exists. Shared between checkGuardrails and checkPriceInventoryGuardrails
 * to avoid duplicating the column-to-AutopilotGuardrails mapping. */
async function loadAutopilotConfig(
  shopId: string,
  sb: SupabaseClient,
  forceBypassOff?: boolean,
): Promise<AutopilotGuardrails | null> {
  const { data: row, error } = await sb
    .from("guardrail_config")
    .select(
      "autopilot_enabled, autopilot_bypass_guardrails, autopilot_daily_action_cap, autopilot_min_spend_cents, autopilot_max_budget_cut_pct, autopilot_max_budget_increase_pct, autopilot_max_daily_budget_cents, dollar_impact_cap_without_2fa, daily_action_budget, cooldown_minutes_per_campaign, business_hours_only, business_hours_start_utc, business_hours_end_utc, autopilot_max_price_change_pct, autopilot_max_inventory_units_per_move",
    )
    .eq("shop_id", shopId)
    .maybeSingle();
  if (error) throw error;
  if (!row) return null;
  const r = row as ConfigRow;
  return {
    enabled: Boolean(r.autopilot_enabled),
    // I1: bypass forced OFF for autonomous calls regardless of DB setting.
    bypassGuardrails: forceBypassOff ? false : Boolean(r.autopilot_bypass_guardrails),
    // null column = no daily cap (unlimited); otherwise the configured integer.
    dailyActionCap:
      r.autopilot_daily_action_cap == null ? null : Number(r.autopilot_daily_action_cap),
    minSpendCents: Number(r.autopilot_min_spend_cents ?? 0),
    maxBudgetCutPct: Number(r.autopilot_max_budget_cut_pct ?? 0),
    maxBudgetIncreasePct: Number(r.autopilot_max_budget_increase_pct ?? 20),
    maxDailyBudgetCents:
      r.autopilot_max_daily_budget_cents == null ? null : Number(r.autopilot_max_daily_budget_cents),
    dollarCapCents: Math.round(Number(r.dollar_impact_cap_without_2fa ?? 0) * 100),
    // daily_action_budget stored in DOLLARS in DB; convert to cents for evaluator.
    dailyActionBudgetCents:
      r.daily_action_budget == null ? null : Math.round(Number(r.daily_action_budget) * 100),
    cooldownMinutes: Number(r.cooldown_minutes_per_campaign ?? 0),
    businessHoursOnly: Boolean(r.business_hours_only),
    businessHoursStartUtc: Number(r.business_hours_start_utc ?? 0),
    businessHoursEndUtc: Number(r.business_hours_end_utc ?? 0),
    // Bounded-magnitude caps for autonomous price/inventory actions (§2.4).
    // Default 10% max price move; null inventory cap = unlimited (merchant opts in).
    maxPriceChangePct: Number(r.autopilot_max_price_change_pct ?? 10),
    maxInventoryUnitsPerMove:
      r.autopilot_max_inventory_units_per_move == null
        ? null
        : Number(r.autopilot_max_inventory_units_per_move),
  };
}

/** Count today's succeeded autopilot actions (UTC day). Exported so the SKU
 * remediation guard shares the exact same cap accounting. THROWS on a read
 * error: the daily action cap is a safety gate, and treating an unreadable
 * count as 0 would fail OPEN (unlimited actions exactly when the accounting
 * is unavailable). Callers treat a throw as a blocked/failed candidate. */
export async function loadTodayAutopilotCount(shopId: string, sb: SupabaseClient): Promise<number> {
  const { count, error } = await sb
    .from("action_audit")
    .select("id", { count: "exact", head: true })
    .eq("shop_id", shopId)
    .eq("actor_user_id", "autopilot")
    .eq("outcome", "succeeded")
    .gte("created_at", startOfUtcDayIso());
  if (error) throw new Error(`today-action-count read failed: ${error.message}`);
  return count ?? 0;
}

/** Sum today's autonomous dollar impact in cents (DOLLARS in DB → cents).
 * Exported so the SKU remediation guard enforces the same I2 aggregate ceiling.
 * THROWS on a read error — an unreadable sum treated as 0 would fail OPEN and
 * waive the daily dollar ceiling exactly when the accounting is unavailable. */
export async function loadTodayAutopilotDollarsCents(shopId: string, sb: SupabaseClient): Promise<number> {
  const { data: dollarRows, error } = await sb
    .from("action_audit")
    .select("dollar_impact_at_exec")
    .eq("shop_id", shopId)
    .eq("actor_user_id", "autopilot")
    .eq("outcome", "succeeded")
    .gte("created_at", startOfUtcDayIso());
  if (error) throw new Error(`today-dollars read failed: ${error.message}`);
  return (dollarRows ?? []).reduce(
    (sum: number, r: { dollar_impact_at_exec: unknown }) =>
      sum + Math.round(Number(r.dollar_impact_at_exec ?? 0) * 100),
    0,
  );
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

  const config = await loadAutopilotConfig(shopId, sb, opts?.forceBypassOff);
  if (!config) return { allowed: false, reason: "no guardrail config" };

  // Count today's autopilot actions (UTC day). Only landed actions consume
  // the cap — a day of transient platform failures (`retrying`/`failed`)
  // must not exhaust it with zero actions actually taken.
  const count = await loadTodayAutopilotCount(shopId, sb);

  // I2: sum today's autonomous dollar impact (DOLLARS in DB → cents here).
  // Only relevant for autonomous calls; merchant calls skip this query.
  let todayAutopilotDollarsCents: number | undefined;
  if (opts?.autonomous) {
    todayAutopilotDollarsCents = await loadTodayAutopilotDollarsCents(shopId, sb);
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
    todayAutopilotCount: count,
    minutesSinceLastActionOnCampaign: minutesSince,
    minutesSinceLastActionOnDestCampaign: minutesSinceDest,
    nowUtcHour: new Date().getUTCHours(),
    todayAutopilotDollarsCents,
    autonomous: opts?.autonomous,
  });
}

/** Input for a price or inventory guardrail check — no campaign UUID required. */
export interface PriceInventoryCheckInput {
  kind: "adjust_price" | "reallocate_inventory";
  dollarImpactCents: number;
  /** Signed price change percentage; required for adjust_price. */
  priceChangePct?: number;
  /** Number of inventory units moved; required for reallocate_inventory. */
  inventoryUnitsMoved?: number;
}

/**
 * Evaluate guardrails for adjust_price and reallocate_inventory autonomous
 * actions. Unlike checkGuardrails, no campaign UUID is needed — there is no
 * campaign-cooldown check, and the min-spend gate is bypassed via isCampaignKind.
 *
 * Always treated as autonomous (forceBypassOff=true, autonomous=true).
 */
export async function checkPriceInventoryGuardrails(
  shopId: string,
  input: PriceInventoryCheckInput,
  sb: SupabaseClient,
): Promise<GuardrailResult> {
  // I1: bypass always forced OFF for autonomous price/inventory actions.
  const config = await loadAutopilotConfig(shopId, sb, true);
  if (!config) return { allowed: false, reason: "no guardrail config" };

  const count = await loadTodayAutopilotCount(shopId, sb);
  // Always autonomous → always accumulate today's dollar spend for I2 check.
  const todayAutopilotDollarsCents = await loadTodayAutopilotDollarsCents(shopId, sb);

  return evaluateGuardrails(config, {
    kind: input.kind,
    dollarImpactCents: input.dollarImpactCents,
    // campaignSpendCents is irrelevant for non-campaign kinds; isCampaignKind
    // guards the min-spend gate so zero here does not spuriously block.
    campaignSpendCents: 0,
    todayAutopilotCount: count,
    // No campaign-cooldown concept for price/inventory actions.
    minutesSinceLastActionOnCampaign: null,
    minutesSinceLastActionOnDestCampaign: null,
    nowUtcHour: new Date().getUTCHours(),
    todayAutopilotDollarsCents,
    autonomous: true,
    priceChangePct: input.priceChangePct,
    inventoryUnitsMoved: input.inventoryUnitsMoved,
  });
}
