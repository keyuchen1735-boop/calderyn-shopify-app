import { describe, it, expect } from "vitest";
import {
  detectFreeShipLeakage,
  type ShipLeakOrder,
} from "../detect-free-ship-leakage";

const order = (o: Partial<ShipLeakOrder> & { orderId: string }): ShipLeakOrder => ({
  orderId: o.orderId,
  lines: o.lines ?? [{ skuId: "sku-a", grams: 100, quantity: 1 }],
  shippingCents: o.shippingCents ?? 0,
  shipCostCents: o.shipCostCents ?? 0,
  shipCostConfidence: o.shipCostConfidence ?? "high",
  zone: o.zone ?? "domestic",
});

describe("detectFreeShipLeakage", () => {
  it("ignores orders that paid for shipping (above the free-ship threshold)", () => {
    const out = detectFreeShipLeakage([
      order({ orderId: "1", shippingCents: 800, shipCostCents: 1500 }),
    ]);
    expect(out).toEqual([]);
  });

  it("fires a SKU cluster when free-ship orders bleed money", () => {
    // 3 free-ship orders, each $25 carrier cost, $0 collected → $75 bleed.
    const orders = ["1", "2", "3"].map((id) =>
      order({ orderId: id, shippingCents: 0, shipCostCents: 2500 }),
    );
    const out = detectFreeShipLeakage(orders);
    const sku = out.find((c) => c.kind === "sku");
    expect(sku).toBeDefined();
    expect(sku!.id).toBe("sku-a");
    expect(sku!.bleedCents).toBe(7500);
    expect(sku!.freeShipOrders).toBe(3);
    expect(sku!.severity).toBe("medium"); // $75 → medium ($50 ≤ bleed < $200)
  });

  it("fires a zone cluster keyed by zone band", () => {
    const orders = ["1", "2"].map((id) =>
      order({ orderId: id, shippingCents: 0, shipCostCents: 6000, zone: "international" }),
    );
    const out = detectFreeShipLeakage(orders);
    const zone = out.find((c) => c.kind === "zone");
    expect(zone).toBeDefined();
    expect(zone!.id).toBe("international");
    expect(zone!.bleedCents).toBe(12000);
    expect(zone!.severity).toBe("medium"); // $120 → medium ($50 ≤ bleed < $200)
  });

  it("splits a multi-SKU order's ship cost across lines by weight", () => {
    // one $40 free-ship order, 2 lines 100g + 300g → sku-a gets $10, sku-b gets $30
    const out = detectFreeShipLeakage([
      order({
        orderId: "1",
        shippingCents: 0,
        shipCostCents: 4000,
        lines: [
          { skuId: "sku-a", grams: 100, quantity: 1 },
          { skuId: "sku-b", grams: 300, quantity: 1 },
        ],
      }),
    ]);
    const a = out.find((c) => c.kind === "sku" && c.id === "sku-a");
    const b = out.find((c) => c.kind === "sku" && c.id === "sku-b");
    // both below the $20 floor individually → neither fires
    expect(a).toBeUndefined();
    expect(b).toBeUndefined();
  });

  it("does NOT fire when the cluster is majority low/fallback confidence", () => {
    // big apparent bleed but dollar-weighted confidence is mostly low
    const out = detectFreeShipLeakage([
      order({ orderId: "1", shippingCents: 0, shipCostCents: 9000, shipCostConfidence: "low" }),
      order({ orderId: "2", shippingCents: 0, shipCostCents: 1000, shipCostConfidence: "high" }),
    ]);
    // 9000 low vs 1000 high → (high+med)/total = 0.1 < 0.5 → skip
    expect(out).toEqual([]);
  });

  it("fires when anchored dollars are the majority even with one big fuzzy order", () => {
    const out = detectFreeShipLeakage([
      order({ orderId: "1", shippingCents: 0, shipCostCents: 1000, shipCostConfidence: "low" }),
      order({ orderId: "2", shippingCents: 0, shipCostCents: 4000, shipCostConfidence: "high" }),
    ]);
    // (high+med)/total = 4000/5000 = 0.8 ≥ 0.5 → fires
    const sku = out.find((c) => c.kind === "sku");
    expect(sku).toBeDefined();
    expect(sku!.shipCostConfidence).toBe("high");
  });

  it("never fires on a positive net (collected ≥ cost)", () => {
    const out = detectFreeShipLeakage([
      order({ orderId: "1", shippingCents: 0, shipCostCents: 0 }),
    ]);
    expect(out).toEqual([]);
  });

  it("suppresses clusters below the $20 bleed floor", () => {
    const out = detectFreeShipLeakage([
      order({ orderId: "1", shippingCents: 0, shipCostCents: 1500 }), // $15 bleed
    ]);
    expect(out).toEqual([]);
  });
});
