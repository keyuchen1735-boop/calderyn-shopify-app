// app/lib/seed/__tests__/scenarios.test.ts
//
// One test per engine detector: each mirrors the detector's SQL predicate
// (engine/calderyn_engine/detectors/*.py) over the generated dataset and
// asserts the intended entity trips it — at the intended severity — while
// healthy entities stay quiet. If a tuning change breaks an arc, the failure
// names the detector it kills.
import { describe, it, expect } from "vitest";
import { generateSeedDataset, type SeedDataset } from "../dataset";

const TODAY = "2026-06-09";
const ds: SeedDataset = generateSeedDataset({
  shopId: "24c18b19-3a4f-4651-9446-969726c30223",
  today: TODAY,
});

function addDays(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

const orderById = new Map(ds.orders.map((o) => [o.id, o]));
const linesByOrder = new Map<string, typeof ds.orderLines>();
for (const l of ds.orderLines) {
  const arr = linesByOrder.get(l.order_id) ?? [];
  arr.push(l);
  linesByOrder.set(l.order_id, arr);
}
const campById = new Map(ds.campaigns.map((c) => [c.id, c]));
const skuById = new Map(ds.skus.map((s) => [s.id, s]));

/** Trailing spend per campaign: day >= today - daysBack (detector date cast). */
function spendWindow(campaignId: string, fromDaysAgo: number, toDaysAgo = 0): number {
  const from = addDays(TODAY, -fromDaysAgo);
  const to = addDays(TODAY, -toDaysAgo);
  return ds.adSpend
    .filter((s) => s.campaign_id === campaignId && s.day >= from && s.day <= to)
    .reduce((sum, s) => sum + s.spend_cents, 0);
}

/** Attributed revenue + derived order COGS per campaign over trailing days. */
function attributedWindow(campaignId: string | null, days: number) {
  const cutoff = addDays(TODAY, -(days - 1));
  let revenue = 0;
  let cogs = 0;
  for (const a of ds.attribution) {
    if (campaignId !== null && a.campaign_id !== campaignId) continue;
    if (a.campaign_id === null) continue;
    const o = orderById.get(a.order_id)!;
    if (o.created_at_source.slice(0, 10) < cutoff) continue;
    revenue += a.attributed_revenue_cents;
    for (const l of linesByOrder.get(o.id) ?? []) cogs += l.unit_cost_cents_snapshot * l.quantity;
  }
  return { revenue, cogs };
}

const mappedSkuByPlatform = new Map(
  ds.creativeSkuMap
    .filter((m) => ["merchant_confirmed", "merchant_manual"].includes(m.source))
    .map((m) => [m.platform, m.sku_id]),
);
const platformSpend = (platform: string, fromDaysAgo: number, toDaysAgo = 0): number =>
  ds.campaigns
    .filter((c) => c.platform === platform)
    .reduce((sum, c) => sum + spendWindow(c.id, fromDaysAgo, toDaysAgo), 0);

const unitMargin30 = (skuId: string): number => {
  const cutoff = addDays(TODAY, -29);
  let margin = 0;
  let units = 0;
  for (const l of ds.orderLines) {
    if (l.sku_id !== skuId) continue;
    if (orderById.get(l.order_id)!.created_at_source.slice(0, 10) < cutoff) continue;
    margin += (l.price_cents - l.unit_cost_cents_snapshot) * l.quantity;
    units += l.quantity;
  }
  return units > 0 ? margin / units : 0;
};

const velocity7 = new Map(
  ds.skuVelocity.filter((v) => v.window_days === 7).map((v) => [v.sku_id, v.units]),
);

describe("detector arcs", () => {
  it("campaign_below_breakeven: only the Summit Tee creator test bleeds (critical)", () => {
    for (const c of ds.campaigns) {
      const spend = spendWindow(c.id, 7);
      const { revenue, cogs } = attributedWindow(c.id, 7);
      const impactUsd = (spend - (revenue - cogs)) / 100;
      if (c.name.includes("Summit Tee")) {
        expect(impactUsd, c.name).toBeGreaterThanOrEqual(2000); // critical = 4x threshold
      } else {
        expect(impactUsd, c.name).toBeLessThan(500);
      }
    }
  });

  it("ad_tax_overload: shop-wide 7d ad spend sits in the 40-72% band of attributed revenue", () => {
    const spend = ds.campaigns.reduce((s, c) => s + spendWindow(c.id, 7), 0);
    const { revenue } = attributedWindow(null, 7);
    expect(spend).toBeGreaterThanOrEqual(100_000); // MIN_SPEND_CENTS
    const ratio = spend / revenue;
    expect(ratio).toBeGreaterThanOrEqual(0.4);
    expect(ratio).toBeLessThan(0.72);
  });

  it("sku_stockout_vs_spend: the meta-mapped hero tee is stocked out under critical spend", () => {
    expect(mappedSkuByPlatform.get("meta")).toBe(ds.scenario.heroTeeSkuId);
    const metaSpend7 = platformSpend("meta", 7);
    expect(metaSpend7).toBeGreaterThanOrEqual(2500 * 100); // critical = 5x $500 threshold
    // Only the tee among mapped SKUs has zero total stock in the 24h window.
    const cutoffTs = `${addDays(TODAY, -1)}T12:00:00.000Z`;
    const totalRecent = (skuId: string) =>
      ds.inventoryLevels
        .filter((i) => i.sku_id === skuId && i.observed_at > cutoffTs)
        .reduce((s, i) => s + i.available, 0);
    expect(totalRecent(ds.scenario.heroTeeSkuId)).toBe(0);
    expect(totalRecent(mappedSkuByPlatform.get("google")!)).toBeGreaterThan(0);
    expect(totalRecent(mappedSkuByPlatform.get("tiktok")!)).toBeGreaterThan(0);
  });

  it("negative_unit_economics: the google-mapped bottle's CAC swamps its margin; the pack stays positive", () => {
    const evaluate = (platform: "meta" | "google" | "tiktok") => {
      const skuId = mappedSkuByPlatform.get(platform)!;
      const cutoff = addDays(TODAY, -13);
      let units = 0;
      let marginCents = 0;
      let attributedUnits = 0;
      const attributedOrders = new Set(
        ds.attribution.filter((a) => a.campaign_id !== null).map((a) => a.order_id),
      );
      for (const l of ds.orderLines) {
        if (l.sku_id !== skuId) continue;
        if (orderById.get(l.order_id)!.created_at_source.slice(0, 10) < cutoff) continue;
        units += l.quantity;
        marginCents += (l.price_cents - l.unit_cost_cents_snapshot) * l.quantity;
        if (attributedOrders.has(l.order_id)) attributedUnits += l.quantity;
      }
      const unitMargin = units > 0 ? marginCents / units : 0;
      const cac = attributedUnits > 0 ? platformSpend(platform, 13) / attributedUnits : 0;
      return { netPerUnit: unitMargin - cac, impactUsd: (Math.abs(unitMargin - cac) * units) / 100 };
    };
    const bottle = evaluate("google");
    expect(bottle.netPerUnit).toBeLessThan(0);
    expect(bottle.impactUsd).toBeGreaterThanOrEqual(500);
    expect(evaluate("tiktok").netPerUnit).toBeGreaterThan(0); // pack: healthy unit econ
  });

  it("scaling_sku_fulfillment_risk: tiktok spend doubles WoW into the pack's 3.5-day cover", () => {
    const thisWeek = platformSpend("tiktok", 7);
    const prevWeek = platformSpend("tiktok", 14, 8);
    expect(prevWeek).toBeGreaterThan(0);
    expect(thisWeek / prevWeek).toBeGreaterThanOrEqual(1.5);
    const cover = ds.stockoutForecasts.find((f) => f.sku_id === ds.scenario.packSkuId)!;
    expect(cover.days_of_cover).toBeLessThan(5);
    expect(velocity7.get(ds.scenario.packSkuId)!).toBeGreaterThan(0);
    // The google-mapped bottle must NOT ride this detector: spend stays flat.
    const googleRatio = platformSpend("google", 7) / platformSpend("google", 14, 8);
    expect(googleRatio).toBeLessThan(1.5);
  });

  it("regional_spend_starved_stock: google spend fans into us-west where the bottle is dry", () => {
    // Fan-out: campaign spend / |geo_targets| flows to each targeted region.
    let westCents = 0;
    for (const c of ds.campaigns) {
      if (c.platform !== "google" || !c.geo_targets.includes("us-west")) continue;
      westCents += spendWindow(c.id, 7) / c.geo_targets.length;
    }
    expect(westCents).toBeGreaterThanOrEqual(500 * 100);
  });

  it("reorder_timing: the hoodie's 6-day cover vs 14-day lead time clears the $200 impact bar", () => {
    const cover = ds.stockoutForecasts.find((f) => f.sku_id === ds.scenario.hoodieLSkuId)!.days_of_cover;
    const gapDays = 14 - cover;
    expect(gapDays).toBeGreaterThan(7); // severity: high
    const daily = velocity7.get(ds.scenario.hoodieLSkuId)! / 7;
    expect(daily).toBeGreaterThanOrEqual(0.1);
    const impactUsd = (daily * gapDays * unitMargin30(ds.scenario.hoodieLSkuId)) / 100;
    expect(impactUsd).toBeGreaterThanOrEqual(200);
  });

  it("return_rate_hidden_loss: windbreaker write-offs clear the $200 impact bar", () => {
    const cutoff = addDays(TODAY, -29);
    let revenue = 0;
    let returns = 0;
    for (const p of ds.skuPnl) {
      if (p.sku_id !== ds.scenario.windbreakerSSkuId || p.day < cutoff) continue;
      revenue += p.revenue_cents;
      returns += p.return_cents;
    }
    expect(revenue).toBeGreaterThanOrEqual(50_000); // MIN_REVENUE_CENTS
    expect(returns / revenue).toBeGreaterThanOrEqual(0.15);
    const sku = skuById.get(ds.scenario.windbreakerSSkuId)!;
    const avgPrice = ds.listPriceCentsBySkuId[sku.id];
    const returnedUnits = returns / avgPrice;
    expect((returnedUnits * sku.unit_cost_cents) / 100).toBeGreaterThanOrEqual(200);
  });

  it("margin_erosion: the duffel's 7d margin drops ≥20% vs baseline for ≥$500; others hold", () => {
    const windowStats = (skuId: string, fromDaysAgo: number, toDaysAgo: number) => {
      const from = addDays(TODAY, -fromDaysAgo);
      const to = addDays(TODAY, -toDaysAgo);
      let units = 0;
      let priceWeighted = 0;
      let costWeighted = 0;
      for (const l of ds.orderLines) {
        if (l.sku_id !== skuId) continue;
        const day = orderById.get(l.order_id)!.created_at_source.slice(0, 10);
        if (day < from || day > to) continue;
        units += l.quantity;
        priceWeighted += l.price_cents * l.quantity;
        costWeighted += l.unit_cost_cents_snapshot * l.quantity;
      }
      return { units, margin: units > 0 ? (priceWeighted - costWeighted) / units : 0 };
    };
    for (const sku of ds.skus) {
      const current = windowStats(sku.id, 6, 0);
      const baseline = windowStats(sku.id, 36, 7);
      if (baseline.units < 20 || current.units === 0 || baseline.margin <= 0) continue;
      const dropPct = (baseline.margin - current.margin) / baseline.margin;
      const impactUsd = ((baseline.margin - current.margin) * current.units) / 100;
      if (sku.id === ds.scenario.duffelSkuId) {
        expect(dropPct).toBeGreaterThanOrEqual(0.2);
        expect(impactUsd).toBeGreaterThanOrEqual(500);
      } else {
        expect(dropPct < 0.2 || impactUsd < 500, `${sku.sku} erodes unexpectedly`).toBe(true);
      }
    }
  });

  it("cogs_drift: the duffel's vendor hike clears 10% drift and $500 exposure", () => {
    const rows = ds.cogsFacts
      .filter((c) => c.sku_id === ds.scenario.duffelSkuId)
      .sort((a, b) => (a.effective_from < b.effective_from ? -1 : 1));
    const drift = (rows[1].unit_cost_cents - rows[0].unit_cost_cents) / rows[0].unit_cost_cents;
    expect(drift).toBeGreaterThanOrEqual(0.1);
    const cutoff = addDays(TODAY, -29);
    let units30 = 0;
    for (const l of ds.orderLines) {
      if (l.sku_id !== ds.scenario.duffelSkuId) continue;
      if (orderById.get(l.order_id)!.created_at_source.slice(0, 10) >= cutoff) units30 += l.quantity;
    }
    expect(((rows[1].unit_cost_cents - rows[0].unit_cost_cents) * units30) / 100).toBeGreaterThanOrEqual(500);
  });

  it("regional_shortage_risk: poles demand outruns us-east stock for ≥$200", () => {
    const locById = new Map(ds.locations.map((l) => [l.id, l]));
    const fulfillByOrder = new Map(ds.fulfillments.map((f) => [f.order_id, f]));
    const cutoff = addDays(TODAY, -29);
    let eastUnits = 0;
    for (const l of ds.orderLines) {
      if (l.sku_id !== ds.scenario.polesSkuId) continue;
      const o = orderById.get(l.order_id)!;
      if (o.created_at_source.slice(0, 10) < cutoff) continue;
      if (locById.get(fulfillByOrder.get(o.id)!.location_id)!.region === "us-east") eastUnits += l.quantity;
    }
    const daily = eastUnits / 30;
    const stock = 8; // pinned by the arc
    const shortfall = daily * 14 - stock;
    expect(shortfall).toBeGreaterThan(0);
    const impactUsd = ((shortfall / daily) * daily * unitMargin30(ds.scenario.polesSkuId)) / 100;
    expect(impactUsd).toBeGreaterThanOrEqual(200);
  });

  it("wrong_location_concentration: shell M parked west clears the $200 carrying-cost bar", () => {
    const impactUsd = (380 * unitMargin30(ds.scenario.shellMSkuId) * 0.1) / 100;
    expect(impactUsd).toBeGreaterThanOrEqual(200);
  });
});

describe("attribution coherence", () => {
  it("attributes a realistic share of orders with valid methods and matching utm", () => {
    const attributedOrders = ds.attribution.filter((a) => a.campaign_id !== null);
    const share = attributedOrders.length / ds.orders.length;
    expect(share).toBeGreaterThan(0.35);
    expect(share).toBeLessThan(0.75);
    for (const a of attributedOrders) {
      const o = orderById.get(a.order_id)!;
      expect(a.attributed_revenue_cents).toBeLessThanOrEqual(o.total_cents);
      expect(["utm_exact", "click_id", "referrer_host"]).toContain(a.attribution_method);
      expect(["high", "strong", "rough"]).toContain(a.confidence);
      if (a.attribution_method === "utm_exact") {
        expect(o.utm_campaign).toBeTruthy();
        expect(o.utm_source).toBeTruthy();
      }
    }
  });

  it("feeds platform ad spend into the mapped SKU's P&L", () => {
    const cutoff = addDays(TODAY, -6);
    for (const [platform, skuId] of mappedSkuByPlatform) {
      const allocated = ds.skuPnl
        .filter((p) => p.sku_id === skuId && p.day >= cutoff)
        .reduce((s, p) => s + p.ad_spend_attrib_cents, 0);
      expect(allocated, platform).toBeGreaterThan(0);
    }
  });

  it("grades every campaign for the anchor day consistently with its 7d ROAS", () => {
    expect(ds.campaignGrades.length).toBe(ds.campaigns.length);
    for (const g of ds.campaignGrades) {
      const spend = spendWindow(g.campaign_id, 6);
      const revenue = ds.adSpend
        .filter((s) => s.campaign_id === g.campaign_id && s.day >= addDays(TODAY, -6))
        .reduce((sum, s) => sum + s.revenue_attrib_cents, 0);
      expect(Math.abs(g.roas - revenue / spend)).toBeLessThan(0.01);
      const name = campById.get(g.campaign_id)!.name;
      if (name.includes("Summit Tee")) expect(g.grade).toBe("F");
      if (name.includes("Brand Search")) expect(["A", "B"]).toContain(g.grade);
    }
  });
});
