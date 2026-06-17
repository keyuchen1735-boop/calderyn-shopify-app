import { describe, it, expect, vi } from "vitest";
import { parseGuardrailForm } from "../app.settings";

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

  it("omits keys that are absent", () => {
    expect(parseGuardrailForm(fd({}))).toEqual({});
  });
});
