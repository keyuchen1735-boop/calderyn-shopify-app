/**
 * rule-enforce.server.ts
 *
 * Loads active calibration_rule rows for a (shop, detector, action) pair and
 * applies them to a candidate action before it reaches the executor.
 *
 * Design choices:
 * - LOAD FAILURE = VETO. If loadPairRules throws (DB error, network fault), we
 *   cannot verify the merchant's learned restrictions. Executing an action when
 *   its governing rules are unknown is UNSAFE. The caller receives a sentinel
 *   ([] with a thrown wrapper) — applyRules handles it via a special code path
 *   in loadAndApplyRules, which treats the failure as an immediate veto:
 *   "rules unavailable". This is the only safe choice for a veto-type enforcer.
 *
 * - First-veto-wins ordering for applyRules: muted_pair first (strongest),
 *   then probation, then blackout hours, then min_spend, then dollar_cap last
 *   (it can produce a cappedDollarCents rather than a veto for reduce actions).
 *
 * - pair_dollar_cap on reduce_campaign_budget: downsizes the cut to the cap
 *   (cappedDollarCents), rather than vetoing, because a smaller autonomous cut
 *   is still loss-prevention. On pause_campaign the impact cannot be split, so
 *   the cap produces a veto.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ActionKind } from "../types";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface CalibrationRule {
  rule_kind: string;
  rule_value: Record<string, unknown>;
}

export interface RuleContext {
  actionKind: ActionKind;
  /** Total dollar impact of this action in cents (e.g. pause impact = full campaign spend). */
  dollarImpactCents: number;
  /** 7-day campaign spend in cents (used for pair_min_spend). */
  campaignSpendCents: number;
  /** Current UTC hour 0–23 (used for pair_blackout_hours). */
  nowUtcHour: number;
  /** Current ISO timestamp string for pair_probation_until comparison. */
  nowIso?: string;
}

export interface RuleVerdict {
  /** Non-null string = action vetoed; never execute. */
  veto?: string;
  /**
   * For reduce_campaign_budget when the dollar_cap kicks in:
   * the MAXIMUM number of cents the cut may remove from the budget.
   * The caller clamps newBudgetCents so (currentBudgetCents - newBudgetCents) <= cappedDollarCents.
   */
  cappedDollarCents?: number;
  /**
   * Learned sizing dial from a pair_mu_override rule (too_aggressive rejects),
   * clamped to [0.05, 1]. The caller combines it with the trained policy dial
   * as min(policyMu, muOverride) — the merchant's learned restraint can only
   * ever SHRINK an autonomous cut/increase, never enlarge it.
   */
  muOverride?: number;
}

// ─── Load ──────────────────────────────────────────────────────────────────

/**
 * Load active calibration_rule rows for one (shop, detector, action) pair.
 *
 * Returns [] on an empty result. THROWS on a Supabase error — the caller
 * (loadAndApplyRules) must treat a thrown load as a veto.
 */
export async function loadPairRules(
  shopId: string,
  detectorId: string,
  actionKind: ActionKind,
  sb: SupabaseClient,
): Promise<CalibrationRule[]> {
  const { data, error } = await sb
    .from("calibration_rule")
    .select("rule_kind, rule_value")
    .eq("shop_id", shopId)
    .eq("detector_id", detectorId)
    .eq("action_kind", actionKind)
    .eq("active", true);

  if (error) {
    throw new Error(`calibration_rule load failed: ${error.message}`);
  }
  return (data ?? []) as CalibrationRule[];
}

// ─── Apply ─────────────────────────────────────────────────────────────────

/**
 * Apply a set of calibration rules to a candidate action context.
 *
 * Rules are checked in a fixed priority order (first veto wins):
 *   1. muted_pair         → always veto
 *   2. pair_probation_until → veto if until > nowIso
 *   3. pair_blackout_hours  → veto if nowUtcHour ∈ rule_value.hours
 *   4. pair_min_spend       → veto if campaignSpendCents < rule_value.cents
 *   5. pair_mu_override     → non-veto: shrink the sizing dial (muOverride)
 *   6. pair_dollar_cap      → veto (pause) or cappedDollarCents (reduce)
 *
 * Non-veto effects (muOverride, cappedDollarCents) accumulate across rules;
 * dollar_cap is the last priority so a veto from it still wins over sizing.
 * Returns {} (no veto, no effects) when all rules pass.
 */
export function applyRules(rules: CalibrationRule[], ctx: RuleContext): RuleVerdict {
  const nowIso = ctx.nowIso ?? new Date().toISOString();
  const effects: RuleVerdict = {};

  for (const rule of sortedRules(rules)) {
    switch (rule.rule_kind) {
      case "muted_pair":
        return { veto: "merchant handles this" };

      case "pair_probation_until": {
        const until = typeof rule.rule_value.until === "string" ? rule.rule_value.until : null;
        if (until && until > nowIso) {
          return { veto: "pair on probation: merchant requested more review time" };
        }
        break;
      }

      case "pair_blackout_hours": {
        const hours = Array.isArray(rule.rule_value.hours) ? (rule.rule_value.hours as number[]) : [];
        if (hours.includes(ctx.nowUtcHour)) {
          return { veto: "outside merchant-allowed hours" };
        }
        break;
      }

      case "pair_min_spend": {
        const minCents = typeof rule.rule_value.cents === "number" ? rule.rule_value.cents : null;
        if (minCents !== null && ctx.campaignSpendCents < minCents) {
          return { veto: "below merchant min spend" };
        }
        break;
      }

      case "pair_mu_override": {
        // Learned restraint on sizing (too_aggressive). Multiple active rows
        // (e.g. the tighten RPC raced a fallback insert) resolve to the
        // TIGHTEST dial. Out-of-range values are clamped, never trusted raw.
        const mu = typeof rule.rule_value.mu === "number" ? rule.rule_value.mu : null;
        if (mu !== null && Number.isFinite(mu)) {
          const clamped = Math.min(1, Math.max(0.05, mu));
          effects.muOverride =
            effects.muOverride === undefined ? clamped : Math.min(effects.muOverride, clamped);
        }
        break;
      }

      case "pair_dollar_cap": {
        const capCents = typeof rule.rule_value.cents === "number" ? rule.rule_value.cents : null;
        if (capCents !== null && ctx.dollarImpactCents > capCents) {
          if (ctx.actionKind === "reduce_campaign_budget") {
            // Downsize the cut to the cap: accumulate a cappedDollarCents the
            // caller uses to clamp (currentBudgetCents - newBudgetCents).
            // Multiple caps resolve to the tightest.
            effects.cappedDollarCents =
              effects.cappedDollarCents === undefined
                ? capCents
                : Math.min(effects.cappedDollarCents, capCents);
            break;
          }
          // pause/increase cannot be partially applied — veto.
          return { veto: "exceeds merchant dollar cap" };
        }
        break;
      }

      // Unknown rule kinds: skip (forward compatible).
      default:
        break;
    }
  }

  return effects;
}

/**
 * Sort rules into priority order so the loop above sees them in a deterministic
 * sequence (first-veto-wins is only deterministic when rules are ordered).
 */
function sortedRules(rules: CalibrationRule[]): CalibrationRule[] {
  const priority: Record<string, number> = {
    muted_pair: 0,
    pair_probation_until: 1,
    pair_blackout_hours: 2,
    pair_min_spend: 3,
    pair_mu_override: 4,
    pair_dollar_cap: 5,
  };
  return [...rules].sort(
    (a, b) => (priority[a.rule_kind] ?? 99) - (priority[b.rule_kind] ?? 99),
  );
}

// ─── Combined load-and-apply (autopilot entry point) ───────────────────────

/**
 * Load rules and apply them. Returns a RuleVerdict.
 *
 * If loadPairRules THROWS, this function returns { veto: "rules unavailable" }
 * — the caller must skip the action. Never execute when rules can't be loaded.
 */
export async function loadAndApplyRules(
  shopId: string,
  detectorId: string,
  actionKind: ActionKind,
  ctx: Omit<RuleContext, "actionKind">,
  sb: SupabaseClient,
): Promise<RuleVerdict> {
  let rules: CalibrationRule[];
  try {
    rules = await loadPairRules(shopId, detectorId, actionKind, sb);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[rule-enforce] loadPairRules threw for (${detectorId}, ${actionKind}): ${msg}`);
    return { veto: "rules unavailable" };
  }
  return applyRules(rules, { ...ctx, actionKind });
}
