import type { BudgetMove } from "./score.server";

export type GateStatic = {
  nowUtc: Date;
  businessHoursStartUtc: number;
  businessHoursEndUtc: number;
  cooldownMinutes: number;
  dollarCapCents: number;
  dailyActionBudgetCents: number;
  lastActionAtByCampaign: Record<string, string | null>;
};

export type GateDecision = { decision: "execute" | "block"; reason: string };

export function inBusinessHours(hourUtc: number, startUtc: number, endUtc: number): boolean {
  if (startUtc === endUtc) return true; // degenerate window = always open
  return startUtc < endUtc
    ? hourUtc >= startUtc && hourUtc < endUtc
    : hourUtc >= startUtc || hourUtc < endUtc; // wraps midnight, e.g. 14 -> 0
}

export function gateMove(move: BudgetMove, usedTodayCents: number, g: GateStatic): GateDecision {
  const hour = g.nowUtc.getUTCHours();
  if (!inBusinessHours(hour, g.businessHoursStartUtc, g.businessHoursEndUtc)) {
    return { decision: "block", reason: "outside_business_hours" };
  }
  const last = g.lastActionAtByCampaign[move.campaignId];
  if (last) {
    const elapsedMin = (g.nowUtc.getTime() - new Date(last).getTime()) / 60000;
    if (elapsedMin < g.cooldownMinutes) return { decision: "block", reason: "cooldown" };
  }
  const magnitude = Math.abs(move.deltaCents);
  if (magnitude > g.dollarCapCents) return { decision: "block", reason: "over_dollar_cap" };
  if (usedTodayCents + magnitude > g.dailyActionBudgetCents) {
    return { decision: "block", reason: "daily_budget_exhausted" };
  }
  return { decision: "execute", reason: "ok" };
}
