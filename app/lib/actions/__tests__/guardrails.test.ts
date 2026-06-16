import { describe, it, expect } from "vitest";
import { evaluateGuardrails } from "../guardrails";
import type { AutopilotGuardrails, GuardrailFacts } from "../guardrails";

const cfg: AutopilotGuardrails = {
  enabled: true,
  dailyActionCap: 3,
  minSpendCents: 20000,
  maxBudgetCutPct: 50,
  maxBudgetIncreasePct: 20,
  maxDailyBudgetCents: null,
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

  it("allows an increase within the max increase %", () => {
    // 10000 -> 12000 is +20%, cap is 20%.
    const r = evaluateGuardrails(cfg, { ...facts, kind: "increase_campaign_budget", currentBudgetCents: 10000, newBudgetCents: 12000 });
    expect(r).toEqual({ allowed: true });
  });
  it("blocks an increase beyond the max increase %", () => {
    const r = evaluateGuardrails(cfg, { ...facts, kind: "increase_campaign_budget", currentBudgetCents: 10000, newBudgetCents: 13000 });
    expect(r).toEqual({ allowed: false, reason: "budget increase exceeds max" });
  });
  it("allows an increase that lands exactly on the daily ceiling", () => {
    // Ceiling is the inclusive max; autopilot clamps to exactly this value.
    // 10000 -> 11000 is +10% (within the 20% cap) and == the ceiling.
    const ceil: AutopilotGuardrails = { ...cfg, maxDailyBudgetCents: 11000 };
    const r = evaluateGuardrails(ceil, { ...facts, kind: "increase_campaign_budget", currentBudgetCents: 10000, newBudgetCents: 11000 });
    expect(r).toEqual({ allowed: true });
  });
  it("blocks an increase above the daily ceiling when one is set", () => {
    // 10000 -> 11500 is +15% (within the 20% cap) but exceeds the 11000 ceiling.
    const ceil: AutopilotGuardrails = { ...cfg, maxDailyBudgetCents: 11000 };
    const r = evaluateGuardrails(ceil, { ...facts, kind: "increase_campaign_budget", currentBudgetCents: 10000, newBudgetCents: 11500 });
    expect(r).toEqual({ allowed: false, reason: "budget exceeds daily ceiling" });
  });
});

describe("evaluateGuardrails · reallocate_budget", () => {
  const cfg: AutopilotGuardrails = {
    enabled: true, dailyActionCap: 10, minSpendCents: 0, maxBudgetCutPct: 50,
    maxBudgetIncreasePct: 20, maxDailyBudgetCents: null,
    dollarCapCents: 100000, cooldownMinutes: 30, businessHoursOnly: false,
    businessHoursStartUtc: 0, businessHoursEndUtc: 0,
  };
  const base: GuardrailFacts = {
    kind: "reallocate_budget", dollarImpactCents: 500, campaignSpendCents: 50000,
    currentBudgetCents: 2000, newBudgetCents: 1500, todayAutopilotCount: 0,
    minutesSinceLastActionOnCampaign: null, minutesSinceLastActionOnDestCampaign: null,
    nowUtcHour: 12,
  };

  it("allows a valid reallocation", () => {
    expect(evaluateGuardrails(cfg, base)).toEqual({ allowed: true });
  });

  it("blocks when the DESTINATION campaign is in cooldown", () => {
    const r = evaluateGuardrails(cfg, { ...base, minutesSinceLastActionOnDestCampaign: 10 });
    expect(r).toEqual({ allowed: false, reason: "destination campaign in cooldown" });
  });

  it("blocks when the SOURCE campaign is in cooldown (existing rule still applies)", () => {
    const r = evaluateGuardrails(cfg, { ...base, minutesSinceLastActionOnCampaign: 10 });
    expect(r).toEqual({ allowed: false, reason: "campaign in cooldown" });
  });

  it("applies maxBudgetCutPct to the SOURCE cut of a reallocation", () => {
    // 1000 -> 400 is a 60% cut > 50% cap.
    const r = evaluateGuardrails(cfg, { ...base, currentBudgetCents: 1000, newBudgetCents: 400 });
    expect(r).toEqual({ allowed: false, reason: "budget cut exceeds max" });
  });

  it("dollar cap covers the amount", () => {
    const r = evaluateGuardrails(cfg, { ...base, dollarImpactCents: 200000 });
    expect(r).toEqual({ allowed: false, reason: "dollar impact exceeds cap" });
  });
});
