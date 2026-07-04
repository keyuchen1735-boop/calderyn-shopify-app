// app/lib/demo/__tests__/showcase-seed.test.ts
//
// Behavior tests for the showcase layer that sits on top of the Peak & Pine
// dataset: owned commerce (buyers/orders), seeded engine alerts, calibration
// baseline, and audit history. Asserts observable coherence (FK integrity,
// determinism, demo-story invariants), not generator internals.
import { describe, it, expect } from "vitest";
import { generateSeedDataset } from "../../seed/dataset";
import { generateShowcaseLayer } from "../showcase-seed";

const SHOP_ID = "9c6d1f6e-15aa-4b60-9a30-1c8a26cf62d1";
const TODAY = "2026-07-03";
const ds = generateSeedDataset({ shopId: SHOP_ID, today: TODAY });
const layer = generateShowcaseLayer({ shopId: SHOP_ID, today: TODAY, dataset: ds });

const dayMs = 24 * 60 * 60 * 1000;
const todayMs = Date.parse(`${TODAY}T00:00:00Z`);

describe("generateShowcaseLayer: determinism + scoping", () => {
  it("is deterministic for the same config", () => {
    expect(generateShowcaseLayer({ shopId: SHOP_ID, today: TODAY, dataset: ds })).toEqual(layer);
  });

  it("scopes every row to the shop", () => {
    const rowSets = [
      layer.buyers, layer.buyerAddresses, layer.buyerConsents, layer.ownedOrders,
      layer.ownedOrderLines, layer.orderTransitions, layer.alerts, layer.alertContexts,
      layer.pairCalibration, layer.auditRows, layer.variantShipping,
    ];
    for (const rows of rowSets) {
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(row.shop_id).toBe(SHOP_ID);
    }
    expect(layer.storeSettings.shop_id).toBe(SHOP_ID);
  });
});

describe("generateShowcaseLayer: owned commerce spine", () => {
  const orderIds = new Set(layer.ownedOrders.map((o) => o.id));
  const buyerIds = new Set(layer.buyers.map((b) => b.id));
  const variantIds = new Set(ds.skus.map((s) => s.id));
  const priceById = ds.listPriceCentsBySkuId;

  it("links every order to a seeded buyer and every line to a seeded variant at list price", () => {
    for (const o of layer.ownedOrders) {
      expect(buyerIds.has(String(o.buyer_id))).toBe(true);
    }
    for (const l of layer.ownedOrderLines) {
      expect(orderIds.has(String(l.order_id))).toBe(true);
      expect(variantIds.has(String(l.variant_id))).toBe(true);
      expect(l.unit_price_cents).toBe(priceById[String(l.variant_id)]);
    }
  });

  it("computes coherent totals and keeps orders inside the recency window", () => {
    for (const o of layer.ownedOrders) {
      const lines = layer.ownedOrderLines.filter((l) => l.order_id === o.id);
      expect(lines.length).toBeGreaterThan(0);
      const subtotal = lines.reduce(
        (sum, l) => sum + Number(l.unit_price_cents) * Number(l.quantity),
        0,
      );
      expect(o.subtotal_cents).toBe(subtotal);
      expect(o.total_cents).toBe(
        subtotal + Number(o.shipping_cents) + Number(o.tax_cents),
      );
      const age = todayMs - Date.parse(String(o.created_at));
      expect(age).toBeGreaterThanOrEqual(0);
      expect(age).toBeLessThanOrEqual(121 * dayMs);
    }
  });

  it("emits a legal state transition history for every order", () => {
    for (const o of layer.ownedOrders) {
      const ts = layer.orderTransitions.filter((t) => t.order_id === o.id);
      expect(ts.length).toBeGreaterThan(0);
      expect(ts[0].from_state).toBe("checkout_pending");
      expect(ts[ts.length - 1].to_state).toBe(o.state);
    }
  });

  it("tells a segmented customer story: a VIP, repeat buyers, and prospects", () => {
    const spend = new Map<string, number>();
    const counts = new Map<string, number>();
    for (const o of layer.ownedOrders) {
      const id = String(o.buyer_id);
      spend.set(id, (spend.get(id) ?? 0) + Number(o.total_cents));
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    expect(Math.max(...spend.values())).toBeGreaterThan(500_000); // VIP > $5k
    expect([...counts.values()].filter((n) => n > 1).length).toBeGreaterThanOrEqual(4);
    const withOrders = new Set(layer.ownedOrders.map((o) => String(o.buyer_id)));
    expect(layer.buyers.some((b) => !withOrders.has(String(b.id)))).toBe(true); // prospects
    // marketing consent rows reference seeded buyers only
    for (const c of layer.buyerConsents) expect(buyerIds.has(String(c.buyer_id))).toBe(true);
  });
});

describe("generateShowcaseLayer: engine story (alerts, calibration, audit)", () => {
  const alertIds = new Set(layer.alerts.map((a) => a.id));
  const campaignIds = new Set(ds.campaigns.map((c) => c.id));
  const skuIds = new Set(ds.skus.map((s) => s.id));

  it("seeds a full open queue with 1:1 evidence context and engine-shaped keys", () => {
    const open = layer.alerts.filter((a) => a.status === "open");
    expect(open.length).toBeGreaterThanOrEqual(10);
    const keys = new Set(
      layer.alerts.map((a) => `${a.detector_id}|${JSON.stringify(a.entity_ref)}|${a.day_bucket}`),
    );
    expect(keys.size).toBe(layer.alerts.length); // engine unique key holds
    for (const a of layer.alerts) {
      expect(a.claude_narrative).toBeTruthy();
      const ctx = layer.alertContexts.filter((c) => c.alert_id === a.id);
      expect(ctx.length).toBe(1);
    }
    for (const a of open) expect(a.day_bucket).toBe(TODAY);
  });

  it("references only seeded campaigns/skus/locations from alert evidence", () => {
    const locationIds = new Set(ds.locations.map((l) => l.id));
    for (const c of layer.alertContexts) {
      const ev = c.evidence as Record<string, unknown>;
      if (typeof ev.campaign_id === "string") expect(campaignIds.has(ev.campaign_id)).toBe(true);
    }
    for (const a of layer.alerts) {
      const ref = a.entity_ref as Record<string, unknown>;
      if (typeof ref.sku_id === "string") expect(skuIds.has(ref.sku_id)).toBe(true);
      if (typeof ref.campaign_id === "string") expect(campaignIds.has(ref.campaign_id)).toBe(true);
      if (typeof ref.location_id === "string") expect(locationIds.has(ref.location_id)).toBe(true);
    }
  });

  it("baselines calibration with exactly two autopilot-ready pairs and headroom to grow", () => {
    const ready = layer.pairCalibration.filter(
      (p) => p.graduated === true && p.autonomy_enabled === true,
    );
    expect(ready.length).toBe(2);
    const growing = layer.pairCalibration.filter((p) => p.graduated === false);
    expect(growing.length).toBeGreaterThanOrEqual(3);
    for (const p of layer.pairCalibration) {
      expect(Number(p.alpha)).toBeGreaterThanOrEqual(0);
      expect(p.merchant_disabled).toBe(false);
    }
  });

  it("gives the audit page history linked to resolved alerts", () => {
    expect(layer.auditRows.length).toBeGreaterThanOrEqual(3);
    for (const row of layer.auditRows) {
      expect(row.outcome).toBe("succeeded");
      expect(alertIds.has(String(row.alert_id))).toBe(true);
      const alert = layer.alerts.find((a) => a.id === row.alert_id);
      expect(alert?.status).toBe("resolved");
      expect(alert?.resolved_at).toBeTruthy();
    }
  });
});

describe("generateShowcaseLayer: storefront + config", () => {
  it("covers every variant with shipping data and brands the store", () => {
    expect(layer.variantShipping.length).toBe(ds.skus.length);
    expect(layer.storeSettings.store_name).toBe("Peak & Pine Outfitters");
    expect(layer.guardrailPatch.autopilot_enabled).toBe(false);
    expect(layer.shopPatch.calibration_pct).toBeNull();
    expect(layer.shopPatch.org_mode).toBe("live");
    expect(layer.shopPatch.onboarding_step).toBe("complete");
  });
});

describe("generateShowcaseLayer: pair_calibration column contracts", () => {
  // pair_calibration's learned columns are NOT NULL with strict types:
  // last_conf integer 0-100, last_detection numeric 0-1, last_outcome_sign
  // smallint -1/0/1. Wrong shapes here abort the whole reset at insert time.
  it("writes DB-valid learned-column values on every pair", () => {
    for (const p of layer.pairCalibration) {
      expect(Number.isInteger(p.last_conf)).toBe(true);
      expect(Number(p.last_conf)).toBeGreaterThanOrEqual(0);
      expect(Number(p.last_conf)).toBeLessThanOrEqual(100);
      expect(typeof p.last_detection).toBe("number");
      expect(Number(p.last_detection)).toBeGreaterThan(0);
      expect(Number(p.last_detection)).toBeLessThanOrEqual(1);
      expect([-1, 0, 1]).toContain(p.last_outcome_sign);
    }
  });
});

describe("generateShowcaseLayer: no future timestamps", () => {
  it("stamps nothing after the provided wall-clock now", () => {
    const now = `${TODAY}T09:15:00.000Z`; // morning run — before the 2pm default
    const l = generateShowcaseLayer({ shopId: SHOP_ID, today: TODAY, dataset: ds, now });
    const nowMs = Date.parse(now);
    const stamps: number[] = [];
    for (const o of l.ownedOrders) stamps.push(Date.parse(String(o.created_at)));
    for (const t of l.orderTransitions) stamps.push(Date.parse(String(t.occurred_at)));
    for (const a of l.alerts) {
      stamps.push(Date.parse(String(a.first_seen_at)), Date.parse(String(a.last_seen_at)));
    }
    for (const b of l.buyers) stamps.push(Date.parse(String(b.created_at)));
    for (const r of l.auditRows) stamps.push(Date.parse(String(r.completed_at)));
    for (const ts of stamps) expect(ts).toBeLessThanOrEqual(nowMs);
  });

  it("never lets a buyer's first order predate the account", () => {
    for (const o of layer.ownedOrders) {
      const buyer = layer.buyers.find((b) => b.id === o.buyer_id);
      expect(Date.parse(String(o.created_at))).toBeGreaterThanOrEqual(
        Date.parse(String(buyer?.created_at)),
      );
    }
  });
});
