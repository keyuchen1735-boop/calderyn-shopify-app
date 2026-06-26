// Pure auto-pilot guardrail evaluation. Returns the first failing rule's reason,
// or { allowed: true }. No I/O — the server wrapper supplies the facts.

import type { ExecutableKind } from "./execute.server";

/** Kinds the guardrail evaluator understands: the single-campaign executables,
 * the composite reallocation, and the high-stakes price/inventory actions. */
export type GuardedKind = ExecutableKind | "reallocate_budget" | "adjust_price" | "reallocate_inventory";

export interface AutopilotGuardrails {
  enabled: boolean;
  /** Bypass mode: when true, skip every safety/rate gate below (still requires
   * `enabled`). Action SIZE is unaffected — autopilot sizes changes from the
   * cut/increase dials regardless. */
  bypassGuardrails: boolean;
  /** Max autopilot actions per UTC day; null = no daily cap for merchant
   * (non-autonomous) calls; for autonomous calls null is treated as 5. */
  dailyActionCap: number | null;
  minSpendCents: number;
  maxBudgetCutPct: number;
  maxBudgetIncreasePct: number;
  /** Hard per-campaign daily-budget ceiling; null = no ceiling. */
  maxDailyBudgetCents: number | null;
  dollarCapCents: number;
  /** Aggregate dollar ceiling for autonomous actions today (cents); null = no ceiling. */
  dailyActionBudgetCents?: number | null;
  cooldownMinutes: number;
  businessHoursOnly: boolean;
  businessHoursStartUtc: number; // 0-23
  businessHoursEndUtc: number;   // 0-23 (may wrap past midnight)
  /** Max autonomous price change magnitude (%). Blocks adjust_price whose
   * |priceChangePct| exceeds this value. Default 10 (conservative). */
  maxPriceChangePct: number;
  /** Max autonomous inventory units moved in a single reallocate_inventory
   * action. null = no autonomous unit cap (merchant opts a cap in). */
  maxInventoryUnitsPerMove: number | null;
}

export interface GuardrailFacts {
  kind: GuardedKind;
  dollarImpactCents: number;
  campaignSpendCents: number;
  currentBudgetCents?: number;
  newBudgetCents?: number;
  todayAutopilotCount: number;
  minutesSinceLastActionOnCampaign: number | null;
  /** Reallocations cool down BOTH campaigns; null/absent for other kinds. */
  minutesSinceLastActionOnDestCampaign?: number | null;
  nowUtcHour: number; // 0-23
  /** Sum of today's autonomous (autopilot) dollar impacts in cents; used for
   * the aggregate daily-dollar ceiling check. Absent for merchant calls. */
  todayAutopilotDollarsCents?: number;
  /** True when the call is from the autopilot (autonomous) path. Affects the
   * null-cap treatment: null = unlimited for merchant calls, 5 for autonomous. */
  autonomous?: boolean;
  /** Signed price change percentage for adjust_price actions. Absent for other
   * kinds. The evaluator checks Math.abs against maxPriceChangePct. */
  priceChangePct?: number;
  /** Number of inventory units moved for reallocate_inventory actions. Absent
   * for other kinds. The evaluator checks this against maxInventoryUnitsPerMove. */
  inventoryUnitsMoved?: number;
}

export interface GuardrailResult {
  allowed: boolean;
  reason?: string;
}

export function withinBusinessHours(startUtc: number, endUtc: number, hour: number): boolean {
  // Window may wrap midnight (e.g. 14 -> 0 means 14:00..24:00).
  if (startUtc === endUtc) return true;
  if (startUtc < endUtc) return hour >= startUtc && hour < endUtc;
  return hour >= startUtc || hour < endUtc;
}

/** Returns true for campaign-centric action kinds. The min-spend gate applies
 * only to campaign kinds — price and inventory actions have no campaign spend
 * concept, so a non-zero minSpendCents must not block them. */
export function isCampaignKind(kind: GuardedKind): boolean {
  return (
    kind === "pause_campaign" ||
    kind === "resume_campaign" ||
    kind === "reduce_campaign_budget" ||
    kind === "increase_campaign_budget" ||
    kind === "reallocate_budget"
  );
}

export function evaluateGuardrails(cfg: AutopilotGuardrails, facts: GuardrailFacts): GuardrailResult {
  if (!cfg.enabled) return { allowed: false, reason: "auto-pilot disabled" };
  // Bypass mode: enabled autopilot, but every safety/rate gate below is waived.
  if (cfg.bypassGuardrails) return { allowed: true };
  // Daily action count cap. For autonomous (autopilot) calls, a null cap is
  // treated as 5 — not unlimited. For merchant (non-autonomous) calls, null
  // means unlimited (preserves existing behavior). This prevents an
  // unconfigured autonomous path from acting without bound.
  const effectiveDailyActionCap =
    cfg.dailyActionCap == null && facts.autonomous ? 5 : cfg.dailyActionCap;
  if (effectiveDailyActionCap != null && facts.todayAutopilotCount >= effectiveDailyActionCap) {
    return { allowed: false, reason: "daily action cap reached" };
  }
  // Min-spend gate applies only to campaign-centric actions. Price and inventory
  // actions have no associated campaign spend, so zero campaignSpendCents must
  // not spuriously block them when the merchant has a minSpendCents threshold.
  if (isCampaignKind(facts.kind) && facts.campaignSpendCents < cfg.minSpendCents) {
    return { allowed: false, reason: "campaign spend below minimum" };
  }
  if (facts.dollarImpactCents > cfg.dollarCapCents) return { allowed: false, reason: "dollar impact exceeds cap" };
  // Aggregate daily-dollar ceiling (I2). Blocks when today's autonomous spend
  // plus this action's impact would exceed the ceiling. Both sides must be
  // present to check — missing either side leaves the check unenforced (safe
  // default: the per-action dollar cap still applies).
  if (
    cfg.dailyActionBudgetCents != null &&
    facts.todayAutopilotDollarsCents != null &&
    facts.todayAutopilotDollarsCents + facts.dollarImpactCents > cfg.dailyActionBudgetCents
  ) {
    return { allowed: false, reason: "daily dollar ceiling reached" };
  }
  if (facts.minutesSinceLastActionOnCampaign != null && facts.minutesSinceLastActionOnCampaign < cfg.cooldownMinutes) {
    return { allowed: false, reason: "campaign in cooldown" };
  }
  if (
    facts.kind === "reallocate_budget" &&
    facts.minutesSinceLastActionOnDestCampaign != null &&
    facts.minutesSinceLastActionOnDestCampaign < cfg.cooldownMinutes
  ) {
    return { allowed: false, reason: "destination campaign in cooldown" };
  }
  if (
    (facts.kind === "reduce_campaign_budget" || facts.kind === "reallocate_budget") &&
    facts.currentBudgetCents != null &&
    facts.currentBudgetCents > 0 &&
    facts.newBudgetCents != null
  ) {
    const cutPct = (1 - facts.newBudgetCents / facts.currentBudgetCents) * 100;
    if (cutPct > cfg.maxBudgetCutPct + 1e-9) return { allowed: false, reason: "budget cut exceeds max" };
  }
  if (
    facts.kind === "increase_campaign_budget" &&
    facts.currentBudgetCents != null &&
    facts.currentBudgetCents > 0 &&
    facts.newBudgetCents != null
  ) {
    const increasePct = (facts.newBudgetCents / facts.currentBudgetCents - 1) * 100;
    if (increasePct > cfg.maxBudgetIncreasePct + 1e-9) {
      return { allowed: false, reason: "budget increase exceeds max" };
    }
    // Strict `>`: the ceiling is the inclusive maximum. Autopilot clamps a
    // target to exactly maxDailyBudgetCents, so a budget AT the ceiling must
    // be allowed — only a budget that truly exceeds it is blocked.
    if (cfg.maxDailyBudgetCents != null && facts.newBudgetCents > cfg.maxDailyBudgetCents) {
      return { allowed: false, reason: "budget exceeds daily ceiling" };
    }
  }
  if (
    facts.kind === "adjust_price" &&
    facts.priceChangePct != null &&
    Math.abs(facts.priceChangePct) > cfg.maxPriceChangePct + 1e-9
  ) {
    return { allowed: false, reason: "price change exceeds max" };
  }
  if (
    facts.kind === "reallocate_inventory" &&
    cfg.maxInventoryUnitsPerMove != null &&
    facts.inventoryUnitsMoved != null &&
    facts.inventoryUnitsMoved > cfg.maxInventoryUnitsPerMove
  ) {
    return { allowed: false, reason: "inventory move exceeds max units" };
  }
  if (cfg.businessHoursOnly && !withinBusinessHours(cfg.businessHoursStartUtc, cfg.businessHoursEndUtc, facts.nowUtcHour)) {
    return { allowed: false, reason: "outside business hours" };
  }
  return { allowed: true };
}
