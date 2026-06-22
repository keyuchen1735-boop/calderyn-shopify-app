// SKU-scoped guardrail check for autopilot remediation moves that act on a
// product rather than a campaign (e.g. discontinue_sku). The campaign guard
// (guardrails.server.ts) needs a campaignId for its cooldown .or() filter and
// reads campaign-budget facts; a SKU move has neither. This reuses the SHARED
// config + the same autopilot-action-cap count so a SKU action and a campaign
// action draw from one budget, but applies only the kind-agnostic rules:
// enabled, daily action cap, dollar cap, business hours. No new guardrail.
import type { SupabaseClient } from "@supabase/supabase-js";
import { withinBusinessHours, type GuardrailResult } from "./guardrails";

function startOfUtcDayIso(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

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
      "autopilot_enabled, autopilot_daily_action_cap, dollar_impact_cap_without_2fa, business_hours_only, business_hours_start_utc, business_hours_end_utc",
    )
    .eq("shop_id", shopId)
    .maybeSingle();
  if (error) throw error;
  if (!row) return { allowed: false, reason: "no guardrail config" };

  if (!row.autopilot_enabled) return { allowed: false, reason: "auto-pilot disabled" };

  const dailyActionCap = Number(row.autopilot_daily_action_cap ?? 0);
  const dollarCapCents = Math.round(Number(row.dollar_impact_cap_without_2fa ?? 0) * 100);

  // Same cap accounting as the campaign guard: only landed (`succeeded`)
  // autopilot actions for today (UTC) consume the cap.
  const { count } = await sb
    .from("action_audit")
    .select("id", { count: "exact", head: true })
    .eq("shop_id", shopId)
    .eq("actor_user_id", "autopilot")
    .eq("outcome", "succeeded")
    .gte("created_at", startOfUtcDayIso());
  if ((count ?? 0) >= dailyActionCap) return { allowed: false, reason: "daily action cap reached" };

  if (input.dollarImpactCents > dollarCapCents) {
    return { allowed: false, reason: "dollar impact exceeds cap" };
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
