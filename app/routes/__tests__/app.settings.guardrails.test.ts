import { describe, it, expect, vi } from "vitest";
import { parseGuardrailForm, changedGuardrailFields } from "../app.settings";
import { validateGuardrailPatch } from "../../lib/dashboard/guardrails-validation";
import type { GuardrailConfig } from "../../lib/types";

// Mock out server-side modules that fail in test environment (no env vars,
// no Shopify SDK initialisation) so we can import the pure helpers.
// vi.mock is hoisted above imports by vitest, so the mocks still apply.
vi.mock("../../shopify.server", () => ({
  authenticate: { admin: vi.fn() },
}));
vi.mock("../../lib/supabase.server", () => ({
  getSupabase: vi.fn(),
  resolveShopId: vi.fn(),
}));
vi.mock("../../lib/calderyn.server", () => ({
  calderynClient: vi.fn(),
  CalderynError: class CalderynError extends Error {},
}));
vi.mock("../../lib/ads/manual-sync.server", () => ({
  manualSyncCooldown: vi.fn(),
  syncShopAds: vi.fn(),
  formatSyncToast: vi.fn(),
}));
vi.mock("../../lib/ship-cost/inputs.server", () => ({
  saveTypedPeriodTotal: vi.fn(),
  ingestInvoiceCsv: vi.fn(),
  setManualOverride: vi.fn(),
}));
vi.mock("../../lib/ship-cost/shop-country.server", () => ({
  getShopCountry: vi.fn().mockResolvedValue(null),
}));
vi.mock("../../lib/ship-cost/unmatched.server", () => ({
  getUnmatchedCharges: vi.fn(),
  mapChargeToOrder: vi.fn(),
}));
vi.mock("../../lib/ship-cost/runner.server", () => ({
  runShipCostResolution: vi.fn(),
}));

function fd(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.append(k, v);
  return f;
}

describe("parseGuardrailForm", () => {
  it("parses budget/cap/cooldown (cents) and autopilot fields", () => {
    const patch = parseGuardrailForm(
      fd({
        daily_action_budget_cents: "75000",
        dollar_cap_cents: "20000",
        cooldown_minutes: "45",
        autopilot_enabled: "true",
        autopilot_max_budget_increase_pct: "25",
      }),
    );
    expect(patch.daily_action_budget_cents).toBe(75000);
    expect(patch.cooldown_minutes).toBe(45);
    expect(patch.autopilot_enabled).toBe(true);
    expect(patch.autopilot_max_budget_increase_pct).toBe(25);
  });

  it("parses the autopilot_bypass_guardrails toggle", () => {
    expect(parseGuardrailForm(fd({ autopilot_bypass_guardrails: "true" })).autopilot_bypass_guardrails).toBe(true);
    expect(parseGuardrailForm(fd({ autopilot_bypass_guardrails: "false" })).autopilot_bypass_guardrails).toBe(false);
  });

  it("parses the business-hours window + only toggle", () => {
    const patch = parseGuardrailForm(
      fd({
        business_hours_only: "true",
        bh_start: "09:00",
        bh_end: "17:00",
        bh_tz: "America/New_York",
      }),
    );
    expect(patch.business_hours_only).toBe(true);
    expect(patch.business_hours).toEqual({ start: "09:00", end: "17:00", tz: "America/New_York" });
  });

  it("parses a null daily ceiling when 'none' is submitted", () => {
    const patch = parseGuardrailForm(fd({ autopilot_max_daily_budget_cents: "" }));
    expect(patch.autopilot_max_daily_budget_cents).toBeNull();
  });

  it("parses a null daily action cap when blank (Unlimited)", () => {
    const patch = parseGuardrailForm(fd({ autopilot_daily_action_cap: "" }));
    expect(patch.autopilot_daily_action_cap).toBeNull();
  });

  it("parses a numeric daily action cap when provided", () => {
    const patch = parseGuardrailForm(fd({ autopilot_daily_action_cap: "8" }));
    expect(patch.autopilot_daily_action_cap).toBe(8);
  });

  it("passes percent fields through unrounded so the validator is the single arbiter", () => {
    // A fractional/out-of-range entry must NOT be silently rounded here (that
    // would diverge from the dashboard's client-side reject); it flows through
    // verbatim and validateGuardrailPatch rejects it visibly.
    const patch = parseGuardrailForm(
      fd({ autopilot_max_budget_cut_pct: "2.5", autopilot_max_budget_increase_pct: "150" }),
    );
    expect(patch.autopilot_max_budget_cut_pct).toBe(2.5);
    expect(patch.autopilot_max_budget_increase_pct).toBe(150);
  });

  it("omits keys that are absent", () => {
    expect(parseGuardrailForm(fd({}))).toEqual({});
  });
});

// Mirrors prod shop 24c18b19: autopilot on, with a grandfathered dollar cap of
// $10M (1_000_000_000 cents) that exceeds the validator's MONEY_CAP_CENTS ceiling.
const CURRENT: GuardrailConfig = {
  daily_action_budget_cents: 1_000_900,
  daily_action_budget_used_cents: 0,
  dollar_cap_cents: 1_000_000_000,
  cooldown_minutes: 0,
  business_hours: { start: "10:00", end: "20:00", tz: "America/New_York" },
  business_hours_only: false,
  in_business_hours: true,
  autopilot_enabled: true,
  autopilot_bypass_guardrails: true,
  autopilot_daily_action_cap: 12,
  autopilot_min_spend_cents: 2_000_000,
  autopilot_max_budget_cut_pct: 50,
  autopilot_max_budget_increase_pct: 20,
  autopilot_max_daily_budget_cents: null,
  max_price_change_pct: 15,
};

describe("changedGuardrailFields", () => {
  it("returns only the fields whose value differs from the current config", () => {
    // The embedded form resubmits EVERY field; the merchant only changed cut %.
    const fullPatch: Partial<GuardrailConfig> = {
      daily_action_budget_cents: 1_000_900,
      dollar_cap_cents: 1_000_000_000, // unchanged + out of range
      cooldown_minutes: 0,
      autopilot_enabled: true,
      autopilot_bypass_guardrails: true,
      autopilot_daily_action_cap: 12,
      autopilot_min_spend_cents: 2_000_000,
      autopilot_max_budget_cut_pct: 30, // the only real change
      autopilot_max_budget_increase_pct: 20,
      autopilot_max_daily_budget_cents: null,
      business_hours: { start: "10:00", end: "20:00", tz: "America/New_York" },
      business_hours_only: false,
    };
    expect(changedGuardrailFields(fullPatch, CURRENT)).toEqual({ autopilot_max_budget_cut_pct: 30 });
  });

  it("lets a limit edit save even when an untouched stored field is out of range (the bug)", () => {
    // Validating the FULL resubmitted patch fails on the grandfathered $10M cap —
    // this is what made every autopilot-limit edit revert. Validating ONLY the
    // changed field passes.
    const fullPatch: Partial<GuardrailConfig> = {
      dollar_cap_cents: 1_000_000_000,
      autopilot_max_budget_cut_pct: 30,
    };
    expect(validateGuardrailPatch(fullPatch)).toBe("invalid_dollar_cap_cents");
    const changed = changedGuardrailFields(fullPatch, CURRENT);
    expect(changed).toEqual({ autopilot_max_budget_cut_pct: 30 });
    expect(validateGuardrailPatch(changed)).toBeNull();
  });

  it("still keeps a genuinely-changed field even if its new value is out of range", () => {
    // Lowering the $10M cap to a valid amount must go through; a still-invalid
    // new value must remain in the patch so the validator can reject it visibly.
    expect(changedGuardrailFields({ dollar_cap_cents: 50_000 }, CURRENT)).toEqual({ dollar_cap_cents: 50_000 });
  });

  it("treats business_hours as changed only when start/end/tz differ", () => {
    expect(
      changedGuardrailFields({ business_hours: { start: "10:00", end: "20:00", tz: "America/New_York" } }, CURRENT),
    ).toEqual({});
    expect(
      changedGuardrailFields({ business_hours: { start: "09:00", end: "20:00", tz: "America/New_York" } }, CURRENT),
    ).toEqual({ business_hours: { start: "09:00", end: "20:00", tz: "America/New_York" } });
  });

  it("returns an empty patch when nothing changed", () => {
    expect(changedGuardrailFields({ autopilot_max_budget_cut_pct: 50, autopilot_enabled: true }, CURRENT)).toEqual({});
  });

  it("drops an untouched FRACTIONAL-dollar grandfathered cap the form rounded (no 422 re-trigger)", () => {
    // Cap stored as $10,000,000.50 (1_000_000_050c). The form displays + resubmits
    // it through whole dollars -> 1_000_000_100c. That is not a merchant change, so
    // it must be dropped; otherwise it re-fails MONEY_CAP and reverts the real edit.
    const current: GuardrailConfig = { ...CURRENT, dollar_cap_cents: 1_000_000_050 };
    const resubmitted: Partial<GuardrailConfig> = {
      dollar_cap_cents: 1_000_000_100, // form's whole-dollar round-trip of the stored cap
      autopilot_max_budget_cut_pct: 30, // the only real change
    };
    expect(changedGuardrailFields(resubmitted, current)).toEqual({ autopilot_max_budget_cut_pct: 30 });
  });

  it("does not silently re-round an untouched sub-dollar money field", () => {
    // Min spend stored as $200.99 (20_099c, reachable via the dashboard's cents
    // entry). The embedded form round-trips it to $201 (20_100c). Toggling autopilot
    // must NOT rewrite a money threshold the merchant never touched (rule 12).
    const current: GuardrailConfig = { ...CURRENT, autopilot_min_spend_cents: 20_099, autopilot_enabled: false };
    const resubmitted: Partial<GuardrailConfig> = {
      autopilot_min_spend_cents: 20_100, // form's whole-dollar round-trip
      autopilot_enabled: true, // the only real change
    };
    expect(changedGuardrailFields(resubmitted, current)).toEqual({ autopilot_enabled: true });
  });

  it("still detects a real whole-dollar money change", () => {
    expect(changedGuardrailFields({ autopilot_min_spend_cents: 30_000 }, CURRENT)).toEqual({
      autopilot_min_spend_cents: 30_000,
    });
  });
});
