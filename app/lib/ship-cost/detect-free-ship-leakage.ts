import { splitOrderShipCost, type SplitLine } from "./split";
import type { Zone } from "./zone";
import type { Severity } from "../types";
import type { ShipCostConfidence } from "./types";

/** Orders below this collected-shipping amount count as "free shipping". */
export const FREE_SHIP_THRESHOLD_CENTS = 100; // $1.00
/** Clusters whose bleed is below this never alert (noise floor). */
export const MIN_BLEED_CENTS = 5000; // $50 — matches the minimum severity threshold

export interface ShipLeakLine {
  skuId: string;
  grams: number | null;
  quantity: number;
}

export interface ShipLeakOrder {
  orderId: string;
  lines: ShipLeakLine[];
  /** What the customer paid for shipping (order_fact.shipping_cents). */
  shippingCents: number;
  /** What the merchant paid the carrier (order_fact.ship_cost_cents). */
  shipCostCents: number;
  shipCostConfidence: ShipCostConfidence;
  zone: Zone;
}

export interface LeakCluster {
  kind: "sku" | "zone";
  /** sku_id for sku clusters; zone band for zone clusters. */
  id: string;
  freeShipOrders: number;
  shippingCollectedCents: number;
  shipCostCents: number;
  /** max(0, shipCost - shippingCollected). */
  bleedCents: number;
  severity: Severity;
  /** Dominant confidence tier among contributing ship-cost dollars. */
  shipCostConfidence: ShipCostConfidence;
}

interface Accum {
  freeShipOrders: number;
  shippingCollectedCents: number;
  shipCostCents: number;
  // dollar-weighted confidence buckets
  highCents: number;
  medCents: number;
  lowCents: number;
}

function emptyAccum(): Accum {
  return {
    freeShipOrders: 0,
    shippingCollectedCents: 0,
    shipCostCents: 0,
    highCents: 0,
    medCents: 0,
    lowCents: 0,
  };
}

function addConfidence(a: Accum, conf: ShipCostConfidence, costCents: number): void {
  if (conf === "high") a.highCents += costCents;
  else if (conf === "med") a.medCents += costCents;
  else a.lowCents += costCents;
}

/** Dollar-weighted: anchored (high+med) share of ship-cost dollars ≥ 50%. */
function clearsConfidenceBar(a: Accum): boolean {
  const total = a.highCents + a.medCents + a.lowCents;
  if (total <= 0) return false;
  const anchored = a.highCents + a.medCents;
  return anchored / total >= 0.5 && anchored > 0;
}

function dominantConfidence(a: Accum): ShipCostConfidence {
  if (a.highCents >= a.medCents && a.highCents >= a.lowCents) return "high";
  if (a.medCents >= a.lowCents) return "med";
  return "low";
}

function severityForBleed(bleedCents: number): Severity {
  const usd = bleedCents / 100;
  if (usd >= 500) return "critical";
  if (usd >= 200) return "high";
  if (usd >= 50) return "medium";
  return "low";
}

function finalize(kind: "sku" | "zone", id: string, a: Accum): LeakCluster | null {
  const bleedCents = Math.max(0, a.shipCostCents - a.shippingCollectedCents);
  if (bleedCents < MIN_BLEED_CENTS) return null;
  if (!clearsConfidenceBar(a)) return null;
  return {
    kind,
    id,
    freeShipOrders: a.freeShipOrders,
    shippingCollectedCents: a.shippingCollectedCents,
    shipCostCents: a.shipCostCents,
    bleedCents,
    severity: severityForBleed(bleedCents),
    shipCostConfidence: dominantConfidence(a),
  };
}

/**
 * Cluster free-shipping orders by SKU (per-line split) and by zone band, gate
 * each cluster on dollar-weighted aggregate ship-cost confidence, and return
 * the clusters that bleed money above the floor. Pure: no I/O.
 */
export function detectFreeShipLeakage(orders: ShipLeakOrder[]): LeakCluster[] {
  const bySku = new Map<string, Accum>();
  const byZone = new Map<string, Accum>();

  for (const o of orders) {
    if (o.shippingCents > FREE_SHIP_THRESHOLD_CENTS) continue; // charged for shipping
    if (o.lines.length === 0) continue;

    // Zone cluster: whole order.
    const z = byZone.get(o.zone) ?? emptyAccum();
    z.freeShipOrders += 1;
    z.shippingCollectedCents += o.shippingCents;
    z.shipCostCents += o.shipCostCents;
    addConfidence(z, o.shipCostConfidence, o.shipCostCents);
    byZone.set(o.zone, z);

    // SKU cluster: split this order's ship cost AND shipping across its lines.
    const splitLines: SplitLine[] = o.lines.map((l) => ({
      lineId: l.skuId,
      grams: l.grams,
      quantity: l.quantity,
    }));
    const costByLine = splitOrderShipCost(o.shipCostCents, splitLines);
    const shipByLine = splitOrderShipCost(o.shippingCents, splitLines);
    for (const l of o.lines) {
      const a = bySku.get(l.skuId) ?? emptyAccum();
      const costShare = costByLine.get(l.skuId) ?? 0;
      a.freeShipOrders += 1;
      a.shippingCollectedCents += shipByLine.get(l.skuId) ?? 0;
      a.shipCostCents += costShare;
      addConfidence(a, o.shipCostConfidence, costShare);
      bySku.set(l.skuId, a);
    }
  }

  const out: LeakCluster[] = [];
  for (const [id, a] of bySku) {
    const c = finalize("sku", id, a);
    if (c) out.push(c);
  }
  for (const [id, a] of byZone) {
    const c = finalize("zone", id, a);
    if (c) out.push(c);
  }
  return out;
}
