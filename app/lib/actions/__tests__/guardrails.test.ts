import { describe, it, expect } from "vitest";
import { evaluateGuardrails } from "../guardrails";
import type { AutopilotGuardrails, GuardrailFacts } from "../guardrails";

const cfg: AutopilotGuardrails = {
  enabled: true,
  dailyActionCap: 3,
  minSpendCents: 20000,
  maxBudgetCutPct: 50,
  dollarCapCents: 1000000,
  cooldownMinutes: 30,
  businessHoursOnly: false,
  businessHoursStartUtc: 14,
  businessHoursEndUtc: 0,
};

const facts: GuardrailFacts = {
  kind: "pause_campaign",
  dollarImpactCents: 50000,
  campaignSpendCents: 50000,
  currentBudgetCents: 10000,
  newBudgetCents: undefined,
  todayAutopilotCount: 0,
  minutesSinceLastActionOnCampaign: null,
  nowUtcHour: 16,
};

describe("evaluateGuardrails", () => {
  it("allows a clean pause", () => {
    expect(evaluateGuardrails(cfg, facts)).toEqual({ allowed: true });
  });

  it("blocks when auto-pilot is disabled", () => {
    expect(evaluateGuardrails({ ...cfg, enabled: false }, facts)).toMatchObject({ allowed: false });
  });

  it("blocks when the daily action cap is reached", () => {
    expect(evaluateGuardrails(cfg, { ...facts, todayAutopilotCount: 3 }).allowed).toBe(false);
  });

  it("blocks when campaign spend is below the minimum", () => {
    expect(evaluateGuardrails(cfg, { ...facts, campaignSpendCents: 19999 }).allowed).toBe(false);
  });

  it("blocks when the dollar impact exceeds the cap", () => {
    expect(evaluateGuardrails(cfg, { ...facts, dollarImpactCents: 1000001 }).allowed).toBe(false);
  });

  it("blocks an in-cooldown campaign", () => {
    expect(evaluateGuardrails(cfg, { ...facts, minutesSinceLastActionOnCampaign: 10 }).allowed).toBe(false);
  });

  it("blocks a budget cut deeper than the max", () => {
    // current 10000 -> new 4000 is a 60% cut, cap is 50%
    const r = evaluateGuardrails(cfg, { ...facts, kind: "reduce_campaign_budget", newBudgetCents: 4000 });
    expect(r.allowed).toBe(false);
  });

  it("allows a budget cut within the max", () => {
    // current 10000 -> new 5000 is exactly 50%
    const r = evaluateGuardrails(cfg, { ...facts, kind: "reduce_campaign_budget", newBudgetCents: 5000 });
    expect(r.allowed).toBe(true);
  });

  it("blocks outside business hours when business_hours_only", () => {
    // window 14->0 (wraps midnight). hour 5 is outside.
    const r = evaluateGuardrails({ ...cfg, businessHoursOnly: true }, { ...facts, nowUtcHour: 5 });
    expect(r.allowed).toBe(false);
  });
});
