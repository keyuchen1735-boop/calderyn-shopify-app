// app/lib/seed/__tests__/dataset.test.ts
//
// Behavior tests for the demo-store seed dataset. These assert OBSERVABLE
// properties of the generated rows (coherence, determinism, scenario arcs),
// not generator internals — the generator can be rewritten entirely and these
// should still hold.
import { describe, it, expect } from "vitest";
import { generateSeedDataset, SANDBOX_CAMPAIGN_IDS, type SeedConfig } from "../dataset";

const CONFIG: SeedConfig = {
  shopId: "24c18b19-3a4f-4651-9446-969726c30223",
  today: "2026-06-09",
};

describe("generateSeedDataset: catalog + locations", () => {
  const ds = generateSeedDataset(CONFIG);

  it("is deterministic: same config produces an identical dataset", () => {
    expect(generateSeedDataset(CONFIG)).toEqual(ds);
  });

  it("creates active regional locations covering distinct regions", () => {
    expect(ds.locations.length).toBeGreaterThanOrEqual(3);
    const regions = new Set(ds.locations.map((l) => l.region));
    expect(regions.size).toBe(ds.locations.length); // one location per region
    for (const l of ds.locations) {
      expect(l.shop_id).toBe(CONFIG.shopId);
      expect(l.active).toBe(true);
      expect(l.name).not.toMatch(/seed/i); // no placeholder names
    }
  });

  it("creates a coherent catalog: real names, family-consistent pricing, sane margins", () => {
    expect(ds.skus.length).toBeGreaterThanOrEqual(25);
    for (const sku of ds.skus) {
      expect(sku.shop_id).toBe(CONFIG.shopId);
      expect(sku.title).not.toMatch(/seed item/i);
      expect(sku.unit_cost_cents).toBeGreaterThan(0);
      // price comes from the catalog's list price; cost must leave a plausible
      // retail gross margin (30%..85%) — no $7-cost "electronics" nonsense.
      const price = ds.listPriceCentsBySkuId[sku.id];
      expect(price).toBeGreaterThan(sku.unit_cost_cents);
      const margin = (price - sku.unit_cost_cents) / price;
      expect(margin).toBeGreaterThanOrEqual(0.3);
      expect(margin).toBeLessThanOrEqual(0.85);
    }
    // variants of the same product share a category (no apparel+grocery products)
    const byProduct = new Map<string, Set<string>>();
    for (const sku of ds.skus) {
      const set = byProduct.get(sku.product_id) ?? new Set();
      set.add(sku.category ?? "");
      byProduct.set(sku.product_id, set);
    }
    for (const categories of byProduct.values()) expect(categories.size).toBe(1);
  });
});

describe("generateSeedDataset: orders + lines + fulfillments", () => {
  const ds = generateSeedDataset(CONFIG);
  const days = new Set(ds.orders.map((o) => o.created_at_source.slice(0, 10)));

  it("generates ~90 days of orders ending today at realistic volume", () => {
    expect(days.size).toBeGreaterThanOrEqual(85);
    expect(days.has(CONFIG.today)).toBe(true);
    const perDay = ds.orders.length / days.size;
    expect(perDay).toBeGreaterThanOrEqual(15);
    expect(perDay).toBeLessThanOrEqual(80);
  });

  it("shows weekly seasonality: weekends outsell midweek", () => {
    const byDow = new Map<number, { orders: number; days: Set<string> }>();
    for (const o of ds.orders) {
      const day = o.created_at_source.slice(0, 10);
      const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
      const slot = byDow.get(dow) ?? { orders: 0, days: new Set() };
      slot.orders += 1;
      slot.days.add(day);
      byDow.set(dow, slot);
    }
    const avg = (dow: number) => {
      const s = byDow.get(dow)!;
      return s.orders / s.days.size;
    };
    const weekend = (avg(6) + avg(0)) / 2;
    const midweek = (avg(2) + avg(3)) / 2;
    expect(weekend).toBeGreaterThan(midweek * 1.15);
  });

  it("keeps order money math internally consistent", () => {
    const linesByOrder = new Map<string, typeof ds.orderLines>();
    for (const l of ds.orderLines) {
      const arr = linesByOrder.get(l.order_id) ?? [];
      arr.push(l);
      linesByOrder.set(l.order_id, arr);
    }
    for (const o of ds.orders) {
      const lines = linesByOrder.get(o.id) ?? [];
      expect(lines.length).toBeGreaterThan(0);
      const subtotal = lines.reduce((s, l) => s + l.total_cents, 0);
      expect(o.subtotal_cents).toBe(subtotal);
      expect(o.total_cents).toBe(o.subtotal_cents + o.shipping_cents + o.tax_cents - o.discount_cents);
      for (const l of lines) {
        expect(l.total_cents).toBe(l.price_cents * l.quantity);
        expect(l.unit_cost_cents_snapshot).toBeGreaterThan(0);
      }
    }
  });

  it("fulfills every order successfully from an active location", () => {
    const locById = new Map(ds.locations.map((l) => [l.id, l]));
    const byOrder = new Map(ds.fulfillments.map((f) => [f.order_id, f]));
    for (const o of ds.orders) {
      const f = byOrder.get(o.id);
      expect(f, `order ${o.order_number} unfulfilled`).toBeTruthy();
      expect(f!.status).toBe("success");
      expect(locById.has(f!.location_id)).toBe(true);
    }
  });

  it("marks most orders PAID with a realistic refund minority", () => {
    const refunded = ds.orders.filter((o) => o.financial_status !== "PAID").length;
    const rate = refunded / ds.orders.length;
    expect(rate).toBeGreaterThan(0.01);
    expect(rate).toBeLessThan(0.12);
  });
});

describe("generateSeedDataset: inventory + derived facts", () => {
  const ds = generateSeedDataset(CONFIG);
  const arcSkuIds = new Set([
    ds.scenario.heroTeeSkuId,
    ds.scenario.bottleSkuId,
    ds.scenario.polesSkuId,
    ds.scenario.shellMSkuId,
  ]);
  const locById = new Map(ds.locations.map((l) => [l.id, l]));

  // Latest available per (sku, region) — the way the detectors read inventory.
  const latest = new Map<string, Map<string, number>>(); // skuId -> region -> qty
  {
    const seen = new Map<string, string>(); // skuId|locId -> observed_at
    for (const inv of [...ds.inventoryLevels].sort((a, b) => (a.observed_at < b.observed_at ? 1 : -1))) {
      const key = `${inv.sku_id}|${inv.location_id}`;
      if (seen.has(key)) continue;
      seen.set(key, inv.observed_at);
      const region = locById.get(inv.location_id)!.region;
      const perRegion = latest.get(inv.sku_id) ?? new Map<string, number>();
      perRegion.set(region, (perRegion.get(region) ?? 0) + inv.available);
      latest.set(inv.sku_id, perRegion);
    }
  }

  // Regional demand over the trailing 30 days, via fulfillment region — the
  // same join regional_shortage_risk uses.
  const cutoff30 = "2026-05-10";
  const demand30 = new Map<string, Map<string, number>>(); // skuId -> region -> units
  {
    const orderById = new Map(ds.orders.map((o) => [o.id, o]));
    const fulfillByOrder = new Map(ds.fulfillments.map((f) => [f.order_id, f]));
    for (const l of ds.orderLines) {
      const o = orderById.get(l.order_id)!;
      if (o.created_at_source.slice(0, 10) < cutoff30) continue;
      const region = locById.get(fulfillByOrder.get(o.id)!.location_id)!.region;
      const perRegion = demand30.get(l.sku_id) ?? new Map<string, number>();
      perRegion.set(region, (perRegion.get(region) ?? 0) + l.quantity);
      demand30.set(l.sku_id, perRegion);
    }
  }

  it("stocks healthy SKUs above 14 days of regional demand (no shortage noise)", () => {
    for (const sku of ds.skus) {
      if (arcSkuIds.has(sku.id)) continue;
      for (const [region, units] of demand30.get(sku.id) ?? []) {
        const daily = units / 30;
        if (daily <= 0) continue;
        const stock = latest.get(sku.id)?.get(region) ?? 0;
        expect(stock, `${sku.sku} ${region}`).toBeGreaterThan(daily * 14);
      }
    }
  });

  it("keeps healthy SKUs below 80% single-region concentration unless demand matches", () => {
    for (const sku of ds.skus) {
      if (arcSkuIds.has(sku.id)) continue;
      const perRegion = latest.get(sku.id) ?? new Map();
      const total = [...perRegion.values()].reduce((s, q) => s + q, 0);
      if (total <= 0) continue;
      const demandTotal = [...(demand30.get(sku.id) ?? new Map()).values()].reduce((s: number, q: number) => s + q, 0);
      for (const [region, qty] of perRegion) {
        if (qty / total < 0.8) continue;
        const demandShare = demandTotal > 0 ? ((demand30.get(sku.id)?.get(region) ?? 0) / demandTotal) : 1;
        expect(demandShare, `${sku.sku} concentrated in ${region}`).toBeGreaterThanOrEqual(0.3);
      }
    }
  });

  it("stocks out the hero tee everywhere, observed on the anchor day", () => {
    const todayObs = ds.inventoryLevels.filter(
      (i) => i.sku_id === ds.scenario.heroTeeSkuId && i.observed_at.startsWith(CONFIG.today),
    );
    expect(todayObs.length).toBeGreaterThanOrEqual(ds.locations.length);
    expect(todayObs.reduce((s, i) => s + i.available, 0)).toBe(0);
  });

  it("starves the bottle in us-west while stock sits elsewhere", () => {
    const perRegion = latest.get(ds.scenario.bottleSkuId)!;
    expect(perRegion.get("us-west")).toBe(0);
    const elsewhere = [...perRegion.entries()].filter(([r]) => r !== "us-west");
    expect(elsewhere.reduce((s, [, q]) => s + q, 0)).toBeGreaterThan(50);
  });

  it("shorts the poles in us-east below the 14-day lead-time demand", () => {
    const eastDemandDaily = (demand30.get(ds.scenario.polesSkuId)?.get("us-east") ?? 0) / 30;
    expect(eastDemandDaily).toBeGreaterThan(0.3);
    const eastStock = latest.get(ds.scenario.polesSkuId)?.get("us-east") ?? 0;
    expect(eastStock).toBeGreaterThan(0);
    expect(eastStock).toBeLessThan(eastDemandDaily * 14);
  });

  it("parks ≥80% of shell M stock in a region with <30% of its demand", () => {
    const perRegion = latest.get(ds.scenario.shellMSkuId)!;
    const total = [...perRegion.values()].reduce((s, q) => s + q, 0);
    const west = perRegion.get("us-west") ?? 0;
    expect(west / total).toBeGreaterThanOrEqual(0.8);
    const demand = demand30.get(ds.scenario.shellMSkuId) ?? new Map();
    const demandTotal = [...demand.values()].reduce((s: number, q: number) => s + q, 0);
    expect((demand.get("us-west") ?? 0) / demandTotal).toBeLessThan(0.3);
  });

  it("records the duffel COGS hike as SCD2 history (+30%, a week ago); others stable", () => {
    const duffelRows = ds.cogsFacts
      .filter((c) => c.sku_id === ds.scenario.duffelSkuId)
      .sort((a, b) => (a.effective_from < b.effective_from ? -1 : 1));
    expect(duffelRows.length).toBe(2);
    const [prior, current] = duffelRows;
    expect(prior.effective_to).toBe(current.effective_from);
    expect(current.effective_to).toBeNull();
    const drift = (current.unit_cost_cents - prior.unit_cost_cents) / prior.unit_cost_cents;
    expect(drift).toBeGreaterThanOrEqual(0.2);
    for (const sku of ds.skus) {
      if (sku.id === ds.scenario.duffelSkuId) continue;
      const rows = ds.cogsFacts.filter((c) => c.sku_id === sku.id);
      expect(rows.length).toBe(1);
      expect(rows[0].effective_to).toBeNull();
    }
  });

  it("derives sku_pnl from order lines, with the windbreaker return arc visible", () => {
    // Revenue per (sku, day) must equal the order lines that day.
    const lineRev = new Map<string, number>();
    const orderById = new Map(ds.orders.map((o) => [o.id, o]));
    for (const l of ds.orderLines) {
      const day = orderById.get(l.order_id)!.created_at_source.slice(0, 10);
      const key = `${l.sku_id}|${day}`;
      lineRev.set(key, (lineRev.get(key) ?? 0) + l.total_cents);
    }
    for (const p of ds.skuPnl) {
      expect(p.revenue_cents, `${p.sku_id} ${p.day}`).toBe(lineRev.get(`${p.sku_id}|${p.day}`) ?? 0);
      // ship_cost_cents must be present and non-negative.
      expect(p.ship_cost_cents, `ship_cost_cents missing on ${p.sku_id} ${p.day}`).toBeGreaterThanOrEqual(0);
      // Margin formula must now include ship cost.
      expect(p.contribution_margin_cents, `margin formula ${p.sku_id} ${p.day}`).toBe(
        p.revenue_cents - p.cogs_cents - p.ad_spend_attrib_cents - p.return_cents - p.ship_cost_cents,
      );
    }
    const rate30 = (skuId: string) => {
      let rev = 0;
      let ret = 0;
      for (const p of ds.skuPnl) {
        if (p.sku_id !== skuId || p.day < cutoff30) continue;
        rev += p.revenue_cents;
        ret += p.return_cents;
      }
      return rev > 0 ? ret / rev : 0;
    };
    expect(rate30(ds.scenario.windbreakerSSkuId)).toBeGreaterThanOrEqual(0.18);
    for (const sku of ds.skus) {
      if (sku.id === ds.scenario.windbreakerSSkuId) continue;
      expect(rate30(sku.id), sku.sku).toBeLessThan(0.1);
    }
  });

  it("populates ship_cost_cents on every pnl row and deducts it from contribution margin", () => {
    // Every row with revenue must carry a positive ship cost (orders were shipped).
    const rowsWithRevenue = ds.skuPnl.filter((p) => p.revenue_cents > 0);
    expect(rowsWithRevenue.length).toBeGreaterThan(0);
    for (const p of rowsWithRevenue) {
      expect(p.ship_cost_cents, `${p.sku_id} ${p.day}`).toBeGreaterThan(0);
    }
    // Aggregate ship cost across all rows must be non-trivial (>1 % of revenue).
    const totalRev = ds.skuPnl.reduce((s, p) => s + p.revenue_cents, 0);
    const totalShip = ds.skuPnl.reduce((s, p) => s + p.ship_cost_cents, 0);
    expect(totalShip / totalRev).toBeGreaterThan(0.01);
    // Margin must equal revenue − cogs − ad_spend − returns − ship_cost on every row.
    for (const p of ds.skuPnl) {
      expect(p.contribution_margin_cents, `margin check ${p.sku_id} ${p.day}`).toBe(
        p.revenue_cents - p.cogs_cents - p.ad_spend_attrib_cents - p.return_cents - p.ship_cost_cents,
      );
    }
  });

  it("binds campaigns to the live sandbox external ids with realistic shapes", () => {
    expect(ds.campaigns.length).toBeGreaterThanOrEqual(7);
    const byExt = new Map(ds.campaigns.map((c) => [c.external_id, c]));
    // Live Meta campaigns (created PAUSED with no ad sets) + the TikTok sandbox one.
    expect(byExt.get(SANDBOX_CAMPAIGN_IDS.metaBleeder)?.platform).toBe("meta");
    expect(byExt.get(SANDBOX_CAMPAIGN_IDS.metaProspecting)?.platform).toBe("meta");
    expect(byExt.get(SANDBOX_CAMPAIGN_IDS.metaRetargeting)?.platform).toBe("meta");
    expect(byExt.get(SANDBOX_CAMPAIGN_IDS.tiktokSpark)?.platform).toBe("tiktok");
    for (const c of ds.campaigns) {
      expect(c.name).not.toMatch(/seed/i);
      expect(c.status).toBe("active");
      expect(c.daily_budget_cents).toBeGreaterThan(0);
      expect(c.currency).toBe("USD");
    }
  });

  it("keeps every spend row funnel-coherent with platform-plausible rates", () => {
    expect(ds.adSpend.length).toBeGreaterThan(200);
    const campById = new Map(ds.campaigns.map((c) => [c.id, c]));
    for (const s of ds.adSpend) {
      expect(campById.has(s.campaign_id)).toBe(true);
      expect(s.spend_cents).toBeGreaterThan(0);
      expect(s.clicks).toBeLessThanOrEqual(s.impressions);
      expect(s.conversions).toBeLessThanOrEqual(s.clicks);
      expect(s.revenue_attrib_cents).toBeGreaterThanOrEqual(0);
      if (s.impressions > 500) {
        const ctr = s.clicks / s.impressions;
        expect(ctr, `${campById.get(s.campaign_id)!.name} ${s.day}`).toBeGreaterThan(0.003);
        expect(ctr).toBeLessThan(0.12);
      }
    }
  });

  it("computes sku_velocity from actual sales and seeds forecast arcs", () => {
    const cutoff7 = "2026-06-03";
    const orderById = new Map(ds.orders.map((o) => [o.id, o]));
    const sold7 = new Map<string, number>();
    for (const l of ds.orderLines) {
      const day = orderById.get(l.order_id)!.created_at_source.slice(0, 10);
      if (day < cutoff7) continue;
      sold7.set(l.sku_id, (sold7.get(l.sku_id) ?? 0) + l.quantity);
    }
    for (const v of ds.skuVelocity.filter((v) => v.window_days === 7)) {
      expect(v.units, v.sku_id).toBe(sold7.get(v.sku_id) ?? 0);
    }
    const cover = new Map(ds.stockoutForecasts.map((f) => [f.sku_id, f.days_of_cover]));
    expect(cover.get(ds.scenario.heroTeeSkuId)).toBe(0);
    expect(cover.get(ds.scenario.hoodieLSkuId)).toBeLessThan(14);
    expect(cover.get(ds.scenario.packSkuId)).toBeLessThan(5);
    for (const sku of ds.skus) {
      if ([ds.scenario.heroTeeSkuId, ds.scenario.hoodieLSkuId, ds.scenario.packSkuId].includes(sku.id)) continue;
      expect(cover.get(sku.id), sku.sku).toBeGreaterThanOrEqual(14);
    }
  });
});
