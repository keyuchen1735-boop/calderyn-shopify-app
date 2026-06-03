import { describe, it, expect } from "vitest";
import { rollupTrend, rollupSummary, rollupCampaigns } from "../rollup";

const camp = [
  { campaign_external_id: "120", campaign_name: "Prospecting", day_bucket: "2026-05-01", spend_cents: 1000, impressions: 100, link_clicks: 5, purchases: 1, purchase_value_cents: 3000 },
  { campaign_external_id: "120", campaign_name: "Prospecting", day_bucket: "2026-05-02", spend_cents: 1000, impressions: 100, link_clicks: 5, purchases: 1, purchase_value_cents: 1000 },
];
const ads = [
  { campaign_external_id: "120", ad_external_id: "a1", ad_name: "Hero", day_bucket: "2026-05-01", spend_cents: 1000, purchase_value_cents: 3000, reactions: 4, comments: 1, shares: 2, saves: 1, post_engagement: 10 },
];

describe("rollupTrend", () => {
  it("sums spend per day and computes daily ROAS", () => {
    expect(rollupTrend(camp)).toEqual([
      { day_bucket: "2026-05-01", spend_cents: 1000, roas: 3 },
      { day_bucket: "2026-05-02", spend_cents: 1000, roas: 1 },
    ]);
  });
});

describe("rollupSummary", () => {
  it("computes account ROAS, total spend, and engagement", () => {
    const s = rollupSummary(camp, ads, { breakEvenRoas: 2, marginPct: 0.5, confidence: "ok", windowDays: 30 });
    expect(s.total_spend_cents).toBe(2000);
    expect(s.account_roas).toBeCloseTo(2, 5); // 4000/2000
    expect(s.total_engagement).toBe(8); // 4+1+2+1
    expect(s.break_even_roas).toBe(2);
    expect(s.window_days).toBe(30);
  });
});

describe("rollupCampaigns", () => {
  it("aggregates per campaign, grades, and attaches engagement + alerts", () => {
    const rows = rollupCampaigns(camp, ads, 2, { "120": ["alert-1"] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      campaign_id: "120",
      spend_cents: 2000,
      purchase_value_cents: 4000,
      roas: 2,
      break_even_roas: 2,
      grade: "okay", // 2 >= 0.95*2 but < 1.2*2
      linked_alert_ids: ["alert-1"],
    });
    expect(rows[0].engagement).toMatchObject({ reactions: 4, shares: 2 });
  });
});
