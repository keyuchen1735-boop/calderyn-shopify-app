import { describe, it, expect, vi } from "vitest";
import { buildAdminUninstallUrl } from "../app.settings";

// Mock out server-side modules that fail in the test environment (no env vars,
// no Shopify SDK init) so we can import the pure helper. vi.mock is hoisted
// above imports by vitest, so the mocks still apply. Mirrors the preamble in
// app.settings.shipcost.test.ts.
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

describe("buildAdminUninstallUrl", () => {
  it("targets the admin Apps settings page keyed by the bare store handle", () => {
    expect(buildAdminUninstallUrl("calderyn-shop-tester.myshopify.com")).toBe(
      "https://admin.shopify.com/store/calderyn-shop-tester/settings/apps",
    );
  });

  it("strips only the .myshopify.com suffix, not interior occurrences", () => {
    expect(buildAdminUninstallUrl("my-store.myshopify.com")).toBe(
      "https://admin.shopify.com/store/my-store/settings/apps",
    );
  });

  it("leaves an already-bare handle untouched", () => {
    expect(buildAdminUninstallUrl("plain-handle")).toBe(
      "https://admin.shopify.com/store/plain-handle/settings/apps",
    );
  });
});
