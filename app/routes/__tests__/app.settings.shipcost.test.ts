import { describe, it, expect, vi } from "vitest";
import {
  parsePeriodTotalForm,
  parseManualOverrideForm,
  parseApiKeyConnectForm,
} from "../app.settings";

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

const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

describe("parsePeriodTotalForm", () => {
  it("parses dollars to cents + carrier + dates", () => {
    const r = parsePeriodTotalForm(
      fd({ amount: "500.00", carrier: "UPS", period_start: "2026-05-01", period_end: "2026-05-31" }),
    );
    expect(r).toEqual({
      ok: true,
      value: { totalCents: 50000, carrier: "UPS", periodStart: "2026-05-01", periodEnd: "2026-05-31" },
    });
  });
  it("rejects a non-positive amount", () => {
    expect(
      parsePeriodTotalForm(fd({ amount: "0", period_start: "2026-05-01", period_end: "2026-05-31" })).ok,
    ).toBe(false);
  });
  it("rejects missing/blank dates", () => {
    expect(
      parsePeriodTotalForm(fd({ amount: "5", period_start: "", period_end: "2026-05-31" })).ok,
    ).toBe(false);
  });
});

describe("parseManualOverrideForm", () => {
  it("parses an order id + dollar override to cents", () => {
    expect(parseManualOverrideForm(fd({ order_id: "o1", amount: "3.33" }))).toEqual({
      ok: true,
      value: { orderId: "o1", cents: 333 },
    });
  });
  it("treats a blank amount as a clear (null cents)", () => {
    expect(parseManualOverrideForm(fd({ order_id: "o1", amount: "" }))).toEqual({
      ok: true,
      value: { orderId: "o1", cents: null },
    });
  });
  it("rejects a missing order id", () => {
    expect(parseManualOverrideForm(fd({ amount: "1.00" })).ok).toBe(false);
  });
});

describe("parseApiKeyConnectForm (EasyPost connect, contract C8)", () => {
  it("accepts a known API-key provider with a non-empty, trimmed key", () => {
    expect(parseApiKeyConnectForm(fd({ provider: "easypost", api_key: "  EZAK_test_123  " }))).toEqual(
      { ok: true, value: { provider: "easypost", apiKey: "EZAK_test_123" } },
    );
  });

  it("rejects an empty/whitespace key — no credential write attempted", () => {
    expect(parseApiKeyConnectForm(fd({ provider: "easypost", api_key: "   " })).ok).toBe(false);
    expect(parseApiKeyConnectForm(fd({ provider: "easypost" })).ok).toBe(false);
  });

  it("rejects an unknown / OAuth provider (easypost is the only API-key provider)", () => {
    expect(parseApiKeyConnectForm(fd({ provider: "meta", api_key: "k" })).ok).toBe(false);
    expect(parseApiKeyConnectForm(fd({ provider: "", api_key: "k" })).ok).toBe(false);
  });
});
