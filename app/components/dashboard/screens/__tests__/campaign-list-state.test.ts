import { describe, expect, it } from "vitest";
import type { CampaignVM } from "../../view-models";
import {
  filterCampaigns,
  missingCampaignCostLabels,
  readCampaignWindow,
  summarizeCampaigns,
  writeCampaignWindow,
} from "../campaign-list-state";

const rows = [
  {
    id: "sale",
    campaign_kind: "sales",
    orders: 10,
    revenue_cents: 40_000,
    spend_cents: 10_000,
    profit_cents: 15_000,
    cost_complete: true,
  },
  {
    id: "regular",
    campaign_kind: "regular",
    orders: 5,
    revenue_cents: 20_000,
    spend_cents: 10_000,
    profit_cents: 6_000,
    cost_complete: false,
  },
] as CampaignVM[];

function memoryStorage(initial?: string) {
  let value = initial ?? null;
  return {
    getItem: () => value,
    setItem: (_key: string, next: string) => {
      value = next;
    },
  };
}

describe("campaign list state", () => {
  it("filters All, Sales, and Regular campaign membership", () => {
    expect(filterCampaigns(rows, "all")).toEqual(rows);
    expect(filterCampaigns(rows, "sales").map((row) => row.id)).toEqual([
      "sale",
    ]);
    expect(filterCampaigns(rows, "regular").map((row) => row.id)).toEqual([
      "regular",
    ]);
  });

  it("keeps the account summary global when a filtered list is displayed", () => {
    const summary = summarizeCampaigns(rows);

    expect(summarizeCampaigns(rows)).toEqual(summary);
    expect(filterCampaigns(rows, "sales")).toHaveLength(1);
    expect(summary).toEqual({
      orders: 15,
      revenueCents: 60_000,
      profitCents: 21_000,
      trueRoas: 3,
      costComplete: false,
    });
  });

  it("returns null ROAS when total spend is zero", () => {
    expect(
      summarizeCampaigns([
        { ...rows[0], spend_cents: 0 },
        { ...rows[1], spend_cents: 0 },
      ]).trueRoas,
    ).toBeNull();
  });

  it("returns null profit only when no campaign has calculable profit", () => {
    expect(
      summarizeCampaigns([
        { ...rows[0], profit_cents: null },
        { ...rows[1], profit_cents: null },
      ]),
    ).toMatchObject({ profitCents: null, costComplete: false });
  });

  it("defaults invalid stored windows to 30 days", () => {
    expect(readCampaignWindow(memoryStorage("14"))).toBe(30);
    expect(readCampaignWindow(memoryStorage())).toBe(30);
    expect(readCampaignWindow()).toBe(30);
  });

  it.each([7, 30, 90] as const)("round-trips the %i-day window", (window) => {
    const storage = memoryStorage();

    writeCampaignWindow(storage, window);

    expect(readCampaignWindow(storage)).toBe(window);
  });

  it("ignores unavailable localStorage instead of blocking reporting", () => {
    const unavailable = {
      getItem: () => { throw new DOMException("blocked", "SecurityError"); },
      setItem: () => { throw new DOMException("full", "QuotaExceededError"); },
    };

    expect(readCampaignWindow(unavailable)).toBe(30);
    expect(() => writeCampaignWindow(unavailable, 90)).not.toThrow();
  });

  it("names each missing cost component from RPC metadata", () => {
    expect(missingCampaignCostLabels(["quickbooks", "missing:cogs", "missing:carrier"]))
      .toEqual(["product costs", "carrier cost"]);
  });
});
