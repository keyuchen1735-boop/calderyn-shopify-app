/**
 * recordRejection: negative calibration signal.
 * Inserts an action_feedback row, bumps the Beta posteriors via SQL RPC,
 * and optionally writes a calibration_rule for the pair.
 *
 * Never throws — the merchant has already seen the rejection UI; a write
 * failure must not interrupt that flow. Failures are logged; the reflection
 * string is always returned.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ActionKind, RejectReason } from "../types";
import { rejectEffect, reflection } from "./feedback";

export interface RecordRejectionInput {
  alertId: string | null;
  detectorId: string;
  actionKind: ActionKind;
  reason: RejectReason;
  note?: string;
  dollarImpactCents: number;
}

export async function recordRejection(
  shopId: string,
  input: RecordRejectionInput,
  sb: SupabaseClient,
): Promise<{ reflection: string }> {
  const eff = rejectEffect(input.reason);

  // Build the jsonb rule value for this reason.
  let appliedRule: Record<string, unknown> | null = null;
  if (eff.ruleKind === "pair_dollar_cap") {
    appliedRule = { cents: Math.max(1, Math.round(0.75 * input.dollarImpactCents)) };
  } else if (eff.ruleKind === "pair_probation_until") {
    const until = new Date();
    until.setDate(until.getDate() + 14);
    appliedRule = { until: until.toISOString() };
  } else if (eff.ruleKind === "muted_pair") {
    appliedRule = {};
  }

  try {
    // 1. Insert action_feedback row.
    const { error: fbError } = await sb.from("action_feedback").insert({
      shop_id: shopId,
      alert_id: input.alertId ?? null,
      detector_id: input.detectorId,
      action_kind: input.actionKind,
      decision: "reject",
      reject_reason: input.reason,
      note: input.note ?? null,
      applied_rule: appliedRule,
    });
    if (fbError) {
      console.error(`[calibration] recordRejection feedback insert failed: ${fbError.message}`);
    }
  } catch (err) {
    console.error(`[calibration] recordRejection feedback insert threw: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    // 2. Bump Beta posteriors via SQL RPC.
    const { error: rpcError } = await sb.rpc("calibration_record_rejection", {
      p_shop_id: shopId,
      p_detector_id: input.detectorId,
      p_action_kind: input.actionKind,
      p_beta_delta: eff.betaDelta,
      p_grad_delta: eff.gradDelta,
      p_mute: eff.mute,
    });
    if (rpcError) {
      console.error(`[calibration] recordRejection rpc failed: ${rpcError.message}`);
    }
  } catch (err) {
    console.error(`[calibration] recordRejection rpc threw: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 3. Write calibration_rule if the effect produces one.
  if (eff.ruleKind !== null) {
    try {
      if (eff.ruleKind === "pair_dollar_cap") {
        // Supersede any existing active pair_dollar_cap for this (shop, detector, action) pair
        // (tighten-only: the new cap is always 75% of the rejected impact).
        const { error: supErr } = await sb
          .from("calibration_rule")
          .update({ active: false })
          .eq("shop_id", shopId)
          .eq("detector_id", input.detectorId)
          .eq("action_kind", input.actionKind)
          .eq("rule_kind", "pair_dollar_cap")
          .eq("active", true);
        if (supErr) {
          console.error(`[calibration] recordRejection supersede failed: ${supErr.message}`);
        }
        // Insert the new active rule.
        const { error: insErr } = await sb.from("calibration_rule").insert({
          shop_id: shopId,
          detector_id: input.detectorId,
          action_kind: input.actionKind,
          rule_kind: eff.ruleKind,
          rule_value: appliedRule ?? {},
          source: input.reason,
          active: true,
        });
        if (insErr) {
          console.error(`[calibration] recordRejection rule insert failed: ${insErr.message}`);
        }
      } else {
        // muted_pair / pair_probation_until: skip if one is already active (no dups).
        const { data: existing, error: selErr } = await sb
          .from("calibration_rule")
          .select("id")
          .eq("shop_id", shopId)
          .eq("detector_id", input.detectorId)
          .eq("action_kind", input.actionKind)
          .eq("rule_kind", eff.ruleKind)
          .eq("active", true)
          .limit(1);
        if (selErr) {
          console.error(`[calibration] recordRejection dup-check failed: ${selErr.message}`);
        }
        if (!existing || existing.length === 0) {
          const { error: insErr } = await sb.from("calibration_rule").insert({
            shop_id: shopId,
            detector_id: input.detectorId,
            action_kind: input.actionKind,
            rule_kind: eff.ruleKind,
            rule_value: appliedRule ?? {},
            source: input.reason,
            active: true,
          });
          if (insErr) {
            console.error(`[calibration] recordRejection rule insert failed: ${insErr.message}`);
          }
        }
      }
    } catch (err) {
      console.error(`[calibration] recordRejection rule write threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { reflection: reflection(input.reason, input.detectorId, input.actionKind) };
}
