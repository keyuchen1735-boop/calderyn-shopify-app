import { describe, it, expect } from "vitest";
import { evaluateGuardrails, type AutopilotGuardrails, type GuardrailFacts } from "../guardrails";

const cfg: AutopilotGuardrails = {
  enabled: true, bypassGuardrails: false, dailyActionCap: 10, minSpendCents: 0,
  maxBudgetCutPct: 50, maxBudgetIncreasePct: 50, maxDailyBudgetCents: null,
  dollarCapCents: 100000, cooldownMinutes: 0, businessHoursOnly: false,
  businessHoursStartUtc: 0, businessHoursEndUtc: 0,
  maxPriceChangePct: 10, maxInventoryUnitsPerMove: 50,
};
const facts = (over: Partial<GuardrailFacts>): GuardrailFacts => ({
  kind: "adjust_price", dollarImpactCents: 0, campaignSpendCents: 0,
  todayAutopilotCount: 0, minutesSinceLastActionOnCampaign: null, nowUtcHour: 12, ...over,
});

describe("price/inventory caps", () => {
  it("blocks a price move beyond the cap", () => {
    const r = evaluateGuardrails(cfg, facts({ kind: "adjust_price", priceChangePct: 25 }));
    expect(r).toEqual({ allowed: false, reason: "price change exceeds max" });
  });
  it("allows a price move at the cap", () => {
    expect(evaluateGuardrails(cfg, facts({ kind: "adjust_price", priceChangePct: 10 })).allowed).toBe(true);
  });
  it("blocks an inventory move beyond the unit cap", () => {
    const r = evaluateGuardrails(cfg, facts({ kind: "reallocate_inventory", inventoryUnitsMoved: 80 }));
    expect(r).toEqual({ allowed: false, reason: "inventory move exceeds max units" });
  });
});
