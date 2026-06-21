import { describe, it, expect } from "vitest";
import { evaluateGuardrails } from "../guardrails";
import type { AutopilotGuardrails, GuardrailFacts } from "../guardrails";

const cfg: AutopilotGuardrails = {
  enabled: true,
  bypassGuardrails: false,
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

  it("skips the daily-cap check entirely when the cap is null (unlimited)", () => {
    // null cap = "no daily cap": even a wildly high today-count must not block
    // on the daily-cap axis. Every other rule still applies.
    const unlimited: AutopilotGuardrails = { ...cfg, dailyActionCap: null };
    expect(evaluateGuardrails(unlimited, { ...facts, todayAutopilotCount: 999 })).toEqual({
      allowed: true,
    });
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

describe("evaluateGuardrails · bypass mode", () => {
  // These facts violate the daily cap, min spend, dollar cap, cooldown, the cut
  // ceiling, AND business hours at once — bypass mode must ignore all of them.
  const violating: GuardrailFacts = {
    kind: "reduce_campaign_budget",
    dollarImpactCents: 99_999_999, // over the dollar cap
    campaignSpendCents: 0, // below min spend
    currentBudgetCents: 10000,
    newBudgetCents: 1000, // 90% cut, over maxBudgetCutPct
    todayAutopilotCount: 999, // over the daily cap
    minutesSinceLastActionOnCampaign: 1, // inside cooldown
    nowUtcHour: 5, // outside business hours
  };

  it("skips every guardrail gate when bypassGuardrails is on", () => {
    const bypass: AutopilotGuardrails = { ...cfg, bypassGuardrails: true, businessHoursOnly: true };
    expect(evaluateGuardrails(bypass, violating)).toEqual({ allowed: true });
  });

  it("still blocks when autopilot is disabled, even with bypass on", () => {
    // Bypass is subordinate to the enable kill-switch: it must be evaluated
    // AFTER the enabled check, never before it.
    const bypassButOff: AutopilotGuardrails = { ...cfg, enabled: false, bypassGuardrails: true };
    expect(evaluateGuardrails(bypassButOff, violating)).toMatchObject({ allowed: false });
  });
});

describe("evaluateGuardrails · I1 bypass forced off", () => {
  // When the caller sets bypassGuardrails=false (forced by checkGuardrails for
  // autonomous calls), caps must be enforced even if the DB had bypass=true.
  const violatingFacts: GuardrailFacts = {
    kind: "pause_campaign",
    dollarImpactCents: 99_999_999, // over the dollar cap
    campaignSpendCents: 50000,
    todayAutopilotCount: 999, // over the daily cap
    minutesSinceLastActionOnCampaign: null,
    nowUtcHour: 16,
    autonomous: true,
  };

  it("an over-cap action is blocked when bypassGuardrails is false (even if DB had true)", () => {
    // Simulate: DB had autopilot_bypass_guardrails=true but forceBypassOff
    // forced config.bypassGuardrails=false before calling evaluateGuardrails.
    const cfgBypassForcedOff: AutopilotGuardrails = { ...cfg, bypassGuardrails: false };
    const r = evaluateGuardrails(cfgBypassForcedOff, violatingFacts);
    expect(r.allowed).toBe(false);
  });

  it("bypass=true in config allows (merchant path — bypass not forced off)", () => {
    const cfgBypass: AutopilotGuardrails = { ...cfg, bypassGuardrails: true };
    const r = evaluateGuardrails(cfgBypass, { ...violatingFacts, autonomous: false });
    expect(r.allowed).toBe(true);
  });
});

describe("evaluateGuardrails · I2 daily dollar ceiling", () => {
  const baseFacts: GuardrailFacts = {
    kind: "pause_campaign",
    dollarImpactCents: 10_000, // $100
    campaignSpendCents: 50000,
    todayAutopilotCount: 0,
    minutesSinceLastActionOnCampaign: null,
    nowUtcHour: 16,
    autonomous: true,
    todayAutopilotDollarsCents: 0,
  };
  const cfgWithCeiling: AutopilotGuardrails = {
    ...cfg,
    dailyActionBudgetCents: 25_000, // $250 ceiling
  };

  it("blocks when today's sum + this action exceeds the ceiling", () => {
    // 20000 used + 10000 this = 30000 > 25000 ceiling
    const r = evaluateGuardrails(cfgWithCeiling, { ...baseFacts, todayAutopilotDollarsCents: 20_000 });
    expect(r).toEqual({ allowed: false, reason: "daily dollar ceiling reached" });
  });

  it("allows when today's sum + this action is under the ceiling", () => {
    // 10000 used + 10000 this = 20000 <= 25000 ceiling
    const r = evaluateGuardrails(cfgWithCeiling, { ...baseFacts, todayAutopilotDollarsCents: 10_000 });
    expect(r).toEqual({ allowed: true });
  });

  it("allows when today's sum + this action equals the ceiling exactly", () => {
    // 15000 used + 10000 this = 25000 == 25000 ceiling (not strictly >)
    const r = evaluateGuardrails(cfgWithCeiling, { ...baseFacts, todayAutopilotDollarsCents: 15_000 });
    expect(r).toEqual({ allowed: true });
  });

  it("skips the daily-dollar check when dailyActionBudgetCents is null", () => {
    const cfgNoCeiling: AutopilotGuardrails = { ...cfg, dailyActionBudgetCents: null };
    // Even with absurd todayAutopilotDollarsCents: no ceiling = no block on that axis.
    const r = evaluateGuardrails(cfgNoCeiling, { ...baseFacts, todayAutopilotDollarsCents: 999_999_999 });
    expect(r).toEqual({ allowed: true });
  });

  it("skips the daily-dollar check when todayAutopilotDollarsCents is absent (merchant call)", () => {
    // Merchant calls don't supply todayAutopilotDollarsCents — must not block.
    const merchantFacts: GuardrailFacts = {
      kind: "pause_campaign", dollarImpactCents: 10_000, campaignSpendCents: 50000,
      todayAutopilotCount: 0, minutesSinceLastActionOnCampaign: null, nowUtcHour: 16,
    };
    const r = evaluateGuardrails(cfgWithCeiling, merchantFacts);
    expect(r).toEqual({ allowed: true });
  });
});

describe("evaluateGuardrails · null count-cap treatment", () => {
  const nullCapCfg: AutopilotGuardrails = { ...cfg, dailyActionCap: null };
  const baseFacts: GuardrailFacts = {
    kind: "pause_campaign", dollarImpactCents: 50000, campaignSpendCents: 50000,
    currentBudgetCents: 10000, todayAutopilotCount: 5,
    minutesSinceLastActionOnCampaign: null, nowUtcHour: 16,
  };

  it("null cap + autonomous: blocks the 6th action (treated as cap=5)", () => {
    const r = evaluateGuardrails(nullCapCfg, { ...baseFacts, todayAutopilotCount: 5, autonomous: true });
    expect(r).toEqual({ allowed: false, reason: "daily action cap reached" });
  });

  it("null cap + autonomous: allows when count is below the implicit 5 cap", () => {
    const r = evaluateGuardrails(nullCapCfg, { ...baseFacts, todayAutopilotCount: 4, autonomous: true });
    expect(r).toEqual({ allowed: true });
  });

  it("null cap + NOT autonomous: unlimited — count=999 still allows (merchant behavior unchanged)", () => {
    const r = evaluateGuardrails(nullCapCfg, { ...baseFacts, todayAutopilotCount: 999, autonomous: false });
    expect(r).toEqual({ allowed: true });
  });

  it("null cap + absent autonomous flag: unlimited — preserves today's merchant behavior", () => {
    // autonomous absent (undefined) — the original non-autonomous path
    const r = evaluateGuardrails(nullCapCfg, { ...baseFacts, todayAutopilotCount: 999 });
    expect(r).toEqual({ allowed: true });
  });
});

describe("evaluateGuardrails · reallocate_budget", () => {
  const cfg: AutopilotGuardrails = {
    enabled: true, bypassGuardrails: false, dailyActionCap: 10, minSpendCents: 0, maxBudgetCutPct: 50,
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
