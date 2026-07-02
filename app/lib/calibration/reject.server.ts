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
import { trustDelta, type PairEv, type RejectReceipt } from "./delta";
import { recomputeShopCalibration } from "./recompute.server";
import { calibrationActionKind } from "./action-kind";

/** wrong_timing rejects landing in the same UTC hour bin this many times learn
 * a pair_blackout_hours veto for that hour (spec §5 reason-taxonomy table). */
export const BLACKOUT_BIN_THRESHOLD = 3;
const BLACKOUT_WINDOW_DAYS = 90;

export interface RecordRejectionInput {
  alertId: string | null;
  detectorId: string;
  actionKind: ActionKind;
  reason: RejectReason;
  note?: string;
  dollarImpactCents: number;
}

// Best-effort single-pair read for the confidence diff (mirrors the local
// reader in approval.server.ts — kept local on purpose so this money-path file
// has no cross-.server import surface). Returns null on a cold-start pair.
async function readPairEv(
  sb: SupabaseClient,
  shopId: string,
  detectorId: string,
  actionKind: ActionKind,
): Promise<PairEv> {
  const { data, error } = await sb
    .from("pair_calibration")
    .select("alpha, beta, last_detection, consecutive_clean_approvals")
    .eq("shop_id", shopId)
    .eq("detector_id", detectorId)
    .eq("action_kind", actionKind)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const row = (data as Record<string, unknown> | null) ?? null;
  const num = (v: unknown): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  return {
    alpha: num(row?.alpha),
    beta: num(row?.beta),
    lastDetection: row?.last_detection == null ? null : num(row?.last_detection),
    consecutiveCleanApprovals: num(row?.consecutive_clean_approvals),
  };
}

/** wrong_timing structural learning (spec §5): histogram this pair's
 * wrong_timing reject hours (UTC) over the window; every hour bin reaching
 * BLACKOUT_BIN_THRESHOLD becomes part of a pair_blackout_hours rule. The rule
 * is superseded (not duplicated) when the learned hour set changes. Returns
 * true when a rule was written. Best-effort: any failure just skips the
 * structural learning for this reject. */
async function learnBlackoutHours(
  sb: SupabaseClient,
  shopId: string,
  detectorId: string,
  actionKind: ActionKind,
): Promise<boolean> {
  try {
    const sinceIso = new Date(Date.now() - BLACKOUT_WINDOW_DAYS * 86400_000).toISOString();
    const { data: rows, error } = await sb
      .from("action_feedback")
      .select("created_at")
      .eq("shop_id", shopId)
      .eq("detector_id", detectorId)
      .eq("action_kind", actionKind)
      .eq("decision", "reject")
      .eq("reject_reason", "wrong_timing")
      .gte("created_at", sinceIso)
      .limit(500);
    if (error) throw new Error(error.message);

    const bins = new Map<number, number>();
    for (const r of rows ?? []) {
      const t = Date.parse(String(r.created_at));
      if (!Number.isFinite(t)) continue;
      const h = new Date(t).getUTCHours();
      bins.set(h, (bins.get(h) ?? 0) + 1);
    }
    const hours = [...bins.entries()]
      .filter(([, n]) => n >= BLACKOUT_BIN_THRESHOLD)
      .map(([h]) => h)
      .sort((a, b) => a - b);
    if (hours.length === 0) return false;

    const { data: existing, error: exErr } = await sb
      .from("calibration_rule")
      .select("id, rule_value")
      .eq("shop_id", shopId)
      .eq("detector_id", detectorId)
      .eq("action_kind", actionKind)
      .eq("rule_kind", "pair_blackout_hours")
      .eq("active", true)
      .limit(1)
      .maybeSingle();
    if (exErr) throw new Error(exErr.message);
    const existingHours = Array.isArray(
      ((existing?.rule_value ?? null) as Record<string, unknown> | null)?.hours,
    )
      ? ([...((existing?.rule_value as Record<string, unknown>).hours as number[])].sort(
          (a, b) => a - b,
        ) as number[])
      : null;
    if (existingHours && JSON.stringify(existingHours) === JSON.stringify(hours)) {
      return true; // already learned exactly these hours — the veto is active
    }

    const { data: inserted, error: insErr } = await sb
      .from("calibration_rule")
      .insert({
        shop_id: shopId,
        detector_id: detectorId,
        action_kind: actionKind,
        rule_kind: "pair_blackout_hours",
        rule_value: { hours },
        source: "wrong_timing",
        active: true,
      })
      .select("id")
      .single();
    if (insErr) throw new Error(insErr.message);
    if (existing?.id) {
      const { error: supErr } = await sb
        .from("calibration_rule")
        .update({ active: false, superseded_by: inserted?.id ?? null })
        .eq("shop_id", shopId)
        .eq("id", existing.id);
      if (supErr) {
        console.error(`[calibration] blackout supersede failed: ${supErr.message}`);
      }
    }
    return true;
  } catch (err) {
    console.error(
      `[calibration] learnBlackoutHours failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

async function refreshShopCalibrationHeadline(
  shopId: string,
  sb: SupabaseClient,
): Promise<void> {
  try {
    await recomputeShopCalibration(shopId, { sb }, { skipPeerPrior: true, forceVisibleStep: true });
  } catch (err) {
    console.error(
      `[calibration] rejection headline recompute failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function recordRejection(
  shopId: string,
  rawInput: RecordRejectionInput,
  sb: SupabaseClient,
): Promise<{ reflection: string } & RejectReceipt> {
  // Normalize to the kind the pair is CALIBRATED under (mirrors recordApproval):
  // reallocate_spend_sku is not an action_kind enum member and would 22P02 on
  // both the action_feedback insert and the RPC param; it trains the
  // reallocate_budget pair — the same pair the autopilot graduation gate reads.
  const input: RecordRejectionInput = {
    ...rawInput,
    actionKind: calibrationActionKind(rawInput.actionKind),
  };
  const eff = rejectEffect(input.reason);

  // Read the pair's Beta counters BEFORE the bump (best-effort, so the
  // confidence diff for the receipt can never fail the rejection itself).
  let before = { alpha: 0, beta: 0 };
  try {
    before = await readPairEv(sb, shopId, input.detectorId, input.actionKind);
  } catch (err) {
    console.error(`[calibration] recordRejection pair read (before) failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Build the jsonb rule value for this reason.
  let appliedRule: Record<string, unknown> | null = null;
  let capRuleWritten = false;
  if (eff.ruleKind === "pair_dollar_cap") {
    // Tighten-only (compounding): the candidate cap is 75% of the rejected
    // impact, but a learning write may NEVER loosen an existing cap — a later
    // reject of a larger proposal must not widen what autopilot may cut. The
    // whole supersede runs atomically in SQL (calibration_tighten_dollar_cap:
    // lock all active caps → LEAST(candidate, existing) → insert + link
    // superseded_by), so concurrent rejects can't race a looser cap in. Runs
    // BEFORE the action_feedback insert so the frozen applied_rule carries the
    // cents that actually landed.
    const candidateCents = Math.max(1, Math.round(0.75 * input.dollarImpactCents));
    try {
      const { data: finalCents, error: capErr } = await sb.rpc("calibration_tighten_dollar_cap", {
        p_shop_id: shopId,
        p_detector_id: input.detectorId,
        p_action_kind: input.actionKind,
        p_candidate_cents: candidateCents,
        p_source: input.reason,
      });
      if (capErr) throw new Error(capErr.message);
      appliedRule = { cents: Number(finalCents ?? candidateCents) };
      capRuleWritten = true;
    } catch (err) {
      // Best-effort: if the atomic write failed, freeze the candidate cap into
      // the feedback row and let the legacy write path below try the insert.
      console.error(
        `[calibration] recordRejection tighten-cap rpc failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      appliedRule = { cents: candidateCents };
    }
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

  // wrong_timing structural learning (spec §5): the reject hour just landed in
  // the feedback ledger above; histogram the pair's wrong_timing hours and emit
  // a pair_blackout_hours veto once any bin reaches the threshold. Runs AFTER
  // the feedback insert so the current reject counts toward its own bin.
  let blackoutRuleWritten = false;
  if (input.reason === "wrong_timing") {
    blackoutRuleWritten = await learnBlackoutHours(
      sb,
      shopId,
      input.detectorId,
      input.actionKind,
    );
  }

  // Read the pair's Beta counters AFTER the bump for the confidence diff.
  // A reject raises beta, so the delta is <= 0. Best-effort: on a read failure
  // we fall back to `before`, yielding delta 0 rather than failing the reject.
  let after = before;
  try {
    after = await readPairEv(sb, shopId, input.detectorId, input.actionKind);
  } catch (err) {
    console.error(`[calibration] recordRejection pair read (after) failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 3. Write calibration_rule if the effect produces one.
  if (eff.ruleKind !== null && !capRuleWritten) {
    try {
      if (eff.ruleKind === "pair_dollar_cap") {
        // Fallback only: the atomic calibration_tighten_dollar_cap RPC above is
        // the normal writer (supersede + tighten in one transaction). Reaching
        // here means the RPC errored — insert the candidate cap WITHOUT
        // deactivating existing rows: rule enforcement vetoes on the tightest
        // matching cap, so an extra (possibly looser) row is harmless, whereas
        // deactivating a tighter cap here would loosen the merchant's limit.
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

  const { before: confBefore, after: confAfter, delta } = trustDelta(
    input.detectorId,
    input.actionKind,
    before,
    after,
  );

  await refreshShopCalibrationHeadline(shopId, sb);

  return {
    // The reflection names the action the merchant actually clicked (raw kind),
    // while every write above trained the normalized pair — so the confirmation
    // copy matches the button, and the learning lands where autopilot reads it.
    reflection: reflection(input.reason, input.detectorId, rawInput.actionKind),
    delta,
    before: confBefore,
    after: confAfter,
    savedAsRule: eff.ruleKind !== null || blackoutRuleWritten,
    ruleKind: blackoutRuleWritten ? "pair_blackout_hours" : eff.ruleKind,
  };
}
