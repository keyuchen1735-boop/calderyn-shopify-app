import { describe, it, expect } from "vitest";

import { generateSeedDataset, type SeedDataset } from "../dataset";

// Mirrors v_sku_remediation_inputs' `dedicated` rule: each attribution row's
// revenue lands on every SKU in its order, and a SKU is "dedicated" to a
// campaign when it holds >=70% of that campaign's attributed revenue. Product-
// economics remediation only earns executable cut_ads / reallocate_to_winner
// buttons when the loser has such a dedicated active campaign AND a qualifying
// winner exists (rule 12: no dedicated campaign -> advisory, never a dead
// button). This guards that the seed produces both.
function campaignSkuShare(ds: SeedDataset, campaignName: string, skuId: string): number {
  const camp = ds.campaigns.find((c) => c.name === campaignName);
  if (!camp) return 0;
  const skusByOrder = new Map<string, string[]>();
  for (const l of ds.orderLines) {
    const arr = skusByOrder.get(l.order_id) ?? [];
    arr.push(l.sku_id);
    skusByOrder.set(l.order_id, arr);
  }
  const rev = new Map<string, number>();
  for (const at of ds.attribution) {
    if (at.campaign_id !== camp.id) continue;
    for (const sid of skusByOrder.get(at.order_id) ?? []) {
      rev.set(sid, (rev.get(sid) ?? 0) + at.attributed_revenue_cents);
    }
  }
  const total = [...rev.values()].reduce((a, b) => a + b, 0);
  return total > 0 ? (rev.get(skuId) ?? 0) / total : 0;
}

describe("seed: dedicated campaigns enable executable ad-budget remediation", () => {
  const ds = generateSeedDataset({ shopId: "seed-test-shop", today: "2026-06-22" });

  it("the loser (Summit Tee M) is >=70% of its active bleeder campaign", () => {
    const camp = ds.campaigns.find((c) => c.name === "Summit Tee — Creator Whitelisting Test")!;
    expect(camp.status).toBe("active");
    expect(camp.daily_budget_cents ?? 0).toBeGreaterThan(0);
    expect(campaignSkuShare(ds, camp.name, ds.scenario.heroTeeSkuId)).toBeGreaterThanOrEqual(0.7);
  });

  it("a qualifying winner exists: >=70% of an active Meta campaign, positive margin, >=14d cover", () => {
    const cap = ds.skus.find((s) => s.external_id === "variant-switchback-cap-one-size")!;
    const winnerCamp = ds.campaigns.find(
      (c) => c.platform === "meta" && campaignSkuShare(ds, c.name, cap.id) >= 0.7,
    );
    expect(winnerCamp, "a Meta campaign where the winner SKU is >=70% of attribution").toBeTruthy();
    expect(winnerCamp!.status).toBe("active");
    expect(winnerCamp!.daily_budget_cents ?? 0).toBeGreaterThan(0);

    const price = ds.listPriceCentsBySkuId[cap.id];
    expect(price - cap.unit_cost_cents).toBeGreaterThan(0); // positive unit margin
    const cover = ds.stockoutForecasts.find((f) => f.sku_id === cap.id)!.days_of_cover;
    expect(cover).toBeGreaterThanOrEqual(14); // stock headroom to scale into
  });
});
