// Pure auto-pilot guardrail evaluation. Returns the first failing rule's reason,
// or { allowed: true }. No I/O — the server wrapper supplies the facts.

import type { ExecutableKind } from "./execute.server";

export interface AutopilotGuardrails {
  enabled: boolean;
  dailyActionCap: number;
  minSpendCents: number;
  maxBudgetCutPct: number;
  dollarCapCents: number;
  cooldownMinutes: number;
  businessHoursOnly: boolean;
  businessHoursStartUtc: number; // 0-23
  businessHoursEndUtc: number;   // 0-23 (may wrap past midnight)
}

export interface GuardrailFacts {
  kind: ExecutableKind;
  dollarImpactCents: number;
  campaignSpendCents: number;
  currentBudgetCents?: number;
  newBudgetCents?: number;
  todayAutopilotCount: number;
  minutesSinceLastActionOnCampaign: number | null;
  nowUtcHour: number; // 0-23
}

export interface GuardrailResult {
  allowed: boolean;
  reason?: string;
}

function withinBusinessHours(startUtc: number, endUtc: number, hour: number): boolean {
  // Window may wrap midnight (e.g. 14 -> 0 means 14:00..24:00).
  if (startUtc === endUtc) return true;
  if (startUtc < endUtc) return hour >= startUtc && hour < endUtc;
  return hour >= startUtc || hour < endUtc;
}

export function evaluateGuardrails(cfg: AutopilotGuardrails, facts: GuardrailFacts): GuardrailResult {
  if (!cfg.enabled) return { allowed: false, reason: "auto-pilot disabled" };
  if (facts.todayAutopilotCount >= cfg.dailyActionCap) return { allowed: false, reason: "daily action cap reached" };
  if (facts.campaignSpendCents < cfg.minSpendCents) return { allowed: false, reason: "campaign spend below minimum" };
  if (facts.dollarImpactCents > cfg.dollarCapCents) return { allowed: false, reason: "dollar impact exceeds cap" };
  if (facts.minutesSinceLastActionOnCampaign != null && facts.minutesSinceLastActionOnCampaign < cfg.cooldownMinutes) {
    return { allowed: false, reason: "campaign in cooldown" };
  }
  if (
    facts.kind === "reduce_campaign_budget" &&
    facts.currentBudgetCents != null &&
    facts.currentBudgetCents > 0 &&
    facts.newBudgetCents != null
  ) {
    const cutPct = (1 - facts.newBudgetCents / facts.currentBudgetCents) * 100;
    if (cutPct > cfg.maxBudgetCutPct + 1e-9) return { allowed: false, reason: "budget cut exceeds max" };
  }
  if (cfg.businessHoursOnly && !withinBusinessHours(cfg.businessHoursStartUtc, cfg.businessHoursEndUtc, facts.nowUtcHour)) {
    return { allowed: false, reason: "outside business hours" };
  }
  return { allowed: true };
}
