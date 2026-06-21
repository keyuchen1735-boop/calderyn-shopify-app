// Live isGraduated check: reads pair_calibration + active calibration_rule rows,
// computes a graduationVerdict, and returns the boolean.
// NEVER throws — returns false on any read error (fail-safe: non-graduated pairs
// are conservative; a DB hiccup must not grant autonomy).

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ActionKind } from "../types";
import { graduationVerdict } from "./graduation";

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
        "last_conf, graduation_threshold, clean_approvals, consecutive_undos, merchant_disabled",
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
      actionKind,
      lastConf: Number(row.last_conf ?? 0),
      gradThreshold: Number(row.graduation_threshold ?? 100),
      cleanApprovals: Number(row.clean_approvals ?? 0),
      consecutiveUndos: Number(row.consecutive_undos ?? 0),
      merchantDisabled: Boolean(row.merchant_disabled) || mutedByRule,
      onProbation,
      hasUndoBranch,
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
