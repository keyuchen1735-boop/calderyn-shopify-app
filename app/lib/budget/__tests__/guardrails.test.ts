import { describe, it, expect } from "vitest";
import { gateMove, inBusinessHours, type GateStatic } from "../guardrails.server";
import type { BudgetMove } from "../score.server";

const move: BudgetMove = {
  campaignId: "c1", name: "C", fromCents: 5000, toCents: 4000, deltaCents: -1000, role: "cut", roas7d: 0.8,
};

function gate(over: Partial<GateStatic> = {}): GateStatic {
  return {
    nowUtc: new Date("2026-06-02T15:00:00Z"),
    businessHoursStartUtc: 14,
    businessHoursEndUtc: 0, // 14:00..24:00 UTC (wraps)
    cooldownMinutes: 30,
    dollarCapCents: 5000,
    dailyActionBudgetCents: 100000,
    lastActionAtByCampaign: {},
    ...over,
  };
}

describe("inBusinessHours", () => {
  it("handles a normal window", () => {
    expect(inBusinessHours(10, 9, 17)).toBe(true);
    expect(inBusinessHours(17, 9, 17)).toBe(false);
  });
  it("handles a window that wraps midnight (14 -> 0)", () => {
    expect(inBusinessHours(15, 14, 0)).toBe(true);
    expect(inBusinessHours(2, 14, 0)).toBe(false);
  });
  it("treats start==end as always open", () => {
    expect(inBusinessHours(3, 0, 0)).toBe(true);
  });
});

describe("gateMove", () => {
  it("executes inside all guardrails", () => {
    expect(gateMove(move, 0, gate())).toEqual({ decision: "execute", reason: "ok" });
  });
  it("blocks outside business hours", () => {
    expect(gateMove(move, 0, gate({ nowUtc: new Date("2026-06-02T03:00:00Z") }))).toEqual({
      decision: "block", reason: "outside_business_hours",
    });
  });
  it("blocks during cooldown", () => {
    const g = gate({ lastActionAtByCampaign: { c1: "2026-06-02T14:45:00Z" } }); // 15 min ago < 30
    expect(gateMove(move, 0, g)).toEqual({ decision: "block", reason: "cooldown" });
  });
  it("blocks a move larger than the per-action cap", () => {
    expect(gateMove(move, 0, gate({ dollarCapCents: 500 }))).toEqual({
      decision: "block", reason: "over_dollar_cap",
    });
  });
  it("blocks when the daily action budget would be exceeded", () => {
    expect(gateMove(move, 99500, gate())).toEqual({ decision: "block", reason: "daily_budget_exhausted" });
  });
});
