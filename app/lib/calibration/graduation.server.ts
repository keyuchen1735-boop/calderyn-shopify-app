// Live isGraduated check: reads pair_calibration + active calibration_rule rows,
// computes a graduationVerdict, and returns the boolean.
// NEVER throws — returns false on any read error (fail-safe: non-graduated pairs
// are conservative; a DB hiccup must not grant autonomy).

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ActionKind } from "../types";
import { graduationVerdict, GRADUATABLE_V1, MIN_OUTCOMES } from "./graduation";
import { pairConfidence, actionTier } from "./confidence";

/**
 * Action kinds that have a working undo branch.
 * Mirror of GATEWAY_UNDO_KINDS restricted to reversible actions only (spec I7).
 */
const HAS_UNDO_BRANCH: ReadonlySet<ActionKind> = new Set<ActionKind>([
  "pause_campaign",
  "resume_campaign",
  "reduce_campaign_budget",
  "reallocate_budget",
  "reallocate_inventory",
  "discontinue_sku",
]);

/**
 * Live graduation check for a (shop, detector, action) pair.
 *
 * 1. Load pair_calibration row by PK (shop_id, detector_id, action_kind).
 * 2. If no row → false (no calibration history yet).
 * 3. Load active calibration_rule rows for the pair.
 * 4. onProbation = any active pair_probation_until rule where rule_value.until > now.
 * 5. mutedByRule = any active muted_pair rule.
 * 6. hasUndoBranch = actionKind ∈ HAS_UNDO_BRANCH.
 * 7. Call graduationVerdict; return verdict.graduated.
 * 8. On ANY read error → return false.
 */
export async function isGraduated(
  shopId: string,
  detectorId: string,
  actionKind: ActionKind,
  sb: SupabaseClient,
): Promise<boolean> {
  try {
    // 1. Load pair_calibration row.
    const { data: row, error: rowErr } = await sb
      .from("pair_calibration")
      .select(
        "last_conf, graduation_threshold, clean_approvals, consecutive_undos, merchant_disabled, net_positive_outcomes, last_outcome_sign",
      )
      .eq("shop_id", shopId)
      .eq("detector_id", detectorId)
      .eq("action_kind", actionKind)
      .maybeSingle();

    if (rowErr) {
      console.error(`[calibration] isGraduated pair_calibration read failed: ${rowErr.message}`);
      return false;
    }
    // 2. No row → not graduated.
    if (!row) return false;

    // 3. Load active calibration_rule rows for this pair.
    const { data: rules, error: ruleErr } = await sb
      .from("calibration_rule")
      .select("rule_kind, rule_value")
      .eq("shop_id", shopId)
      .eq("detector_id", detectorId)
      .eq("action_kind", actionKind)
      .eq("active", true);

    if (ruleErr) {
      console.error(`[calibration] isGraduated calibration_rule read failed: ${ruleErr.message}`);
      return false;
    }

    const activeRules = rules ?? [];
    const nowIso = new Date().toISOString();

    // 4. onProbation = any active pair_probation_until where rule_value.until > now.
    const onProbation = activeRules.some(
      (r) =>
        r.rule_kind === "pair_probation_until" &&
        typeof r.rule_value === "object" &&
        r.rule_value !== null &&
        typeof (r.rule_value as Record<string, unknown>).until === "string" &&
        (r.rule_value as Record<string, string>).until > nowIso,
    );

    // 5. mutedByRule = any active muted_pair rule.
    const mutedByRule = activeRules.some((r) => r.rule_kind === "muted_pair");

    // 6. hasUndoBranch from the static set.
    const hasUndoBranch = HAS_UNDO_BRANCH.has(actionKind);

    // 7. Compute verdict.
    const verdict = graduationVerdict({
      detectorId,
      actionKind,
      lastConf: Number(row.last_conf ?? 0),
      gradThreshold: Number(row.graduation_threshold ?? 100),
      cleanApprovals: Number(row.clean_approvals ?? 0),
      consecutiveUndos: Number(row.consecutive_undos ?? 0),
      merchantDisabled: Boolean(row.merchant_disabled) || mutedByRule,
      onProbation,
      hasUndoBranch,
      netPositiveOutcomes: Number(row.net_positive_outcomes ?? 0),
      lastOutcomeSign: Number(row.last_outcome_sign ?? 0) as -1 | 0 | 1,
    });

    return verdict.graduated;
  } catch (err) {
    // 8. Fail-safe: never throw; return false.
    console.error(
      `[calibration] isGraduated threw: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

// A pair counts as "near graduation" when its confidence is within this many
// points BELOW its graduation threshold (every other gate already cleared).
const NEAR_GRAD_WINDOW = 15;

/**
 * Count (detector, action) pairs that are close to graduating to autopilot:
 * graduatable in v1, not yet graduated, clearing every non-confidence gate
 * (no mute, no live probation, no consecutive undos, at least one clean
 * approval), and whose current confidence sits within NEAR_GRAD_WINDOW points
 * below the pair's graduation threshold. Drives the "N pairs near graduation"
 * header stat. NEVER throws — returns 0 on any read error (it is cosmetic).
 */
export async function countNearGraduation(
  shopId: string,
  sb: SupabaseClient,
): Promise<number> {
  try {
    const [pairsRes, rulesRes] = await Promise.all([
      sb
        .from("pair_calibration")
        .select(
          "detector_id, action_kind, alpha, beta, clean_approvals, consecutive_undos, merchant_disabled, graduation_threshold, graduated, net_positive_outcomes, last_outcome_sign",
        )
        .eq("shop_id", shopId),
      sb
        .from("calibration_rule")
        .select("detector_id, action_kind, rule_kind, rule_value")
        .eq("shop_id", shopId)
        .eq("active", true),
    ]);
    if (pairsRes.error) {
      console.error(`[calibration] countNearGraduation pair read failed: ${pairsRes.error.message}`);
      return 0;
    }
    if (rulesRes.error) {
      console.error(`[calibration] countNearGraduation rule read failed: ${rulesRes.error.message}`);
      return 0;
    }

    const nowIso = new Date().toISOString();
    const rules = rulesRes.data ?? [];
    const muted = (d: string, a: string): boolean =>
      rules.some((r) => r.detector_id === d && r.action_kind === a && r.rule_kind === "muted_pair");
    const onProbation = (d: string, a: string): boolean =>
      rules.some(
        (r) =>
          r.detector_id === d &&
          r.action_kind === a &&
          r.rule_kind === "pair_probation_until" &&
          typeof (r.rule_value as Record<string, unknown> | null)?.until === "string" &&
          (r.rule_value as Record<string, string>).until > nowIso,
      );

    let count = 0;
    for (const row of pairsRes.data ?? []) {
      const action = row.action_kind as ActionKind;
      if (!GRADUATABLE_V1.has(action)) continue;
      if (row.graduated) continue;
      if (Number(row.clean_approvals ?? 0) < 1) continue;
      if (Number(row.consecutive_undos ?? 0) > 0) continue;
      if (row.merchant_disabled) continue;
      const detector = String(row.detector_id);
      if (muted(detector, action)) continue;
      if (onProbation(detector, action)) continue;
      const tier = actionTier(action);
      if (Number(row.net_positive_outcomes ?? 0) < MIN_OUTCOMES[tier]) continue;
      if (Number(row.last_outcome_sign ?? 0) < 0) continue;
      const threshold = Number(row.graduation_threshold ?? 100) || 100;
      const conf = pairConfidence(
        detector,
        action,
        { alpha: Number(row.alpha ?? 0), beta: Number(row.beta ?? 0) },
        null,
      );
      if (conf >= threshold - NEAR_GRAD_WINDOW && conf < threshold) count++;
    }
    return count;
  } catch (err) {
    console.error(
      `[calibration] countNearGraduation threw: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 0;
  }
}
