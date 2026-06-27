// Builds the Autopilot-features rail model from REAL data: graduated features
// (toggleable) come from LiveEnginePageData.features; "locked" rows are distinct
// (detector, action) pairs the shop is still learning, surfaced from the pending
// Action Queue — nothing here is fabricated. The hero's hex meter and the rail
// share this model so their counts always agree.
import { ACTION_LABELS } from "../format";
import type { WatchGroup } from "../engine-events";
import type { LiveEngineFeatureVM } from "../../../lib/calibration/live-engine-types";
import type { QueueProposalVM } from "../view-models";

export interface FeatureRowVM {
  detectorId: string;
  actionKind: string;
  name: string;
  enabled: boolean;
  locked: boolean;
  moneyCents: number;
  actions: number;
}

export interface FeatureGroupVM {
  key: WatchGroup;
  label: string;
  icon: string;
  rows: FeatureRowVM[];
  onCount: number;
  total: number;
}

const CATEGORY: Record<WatchGroup, { label: string; icon: string }> = {
  ads: { label: "Ads & campaigns", icon: "megaphone" },
  inv: { label: "Inventory", icon: "box" },
  price: { label: "Pricing & promos", icon: "target" },
  ret: { label: "Retention", icon: "assist" },
};
const ORDER: WatchGroup[] = ["ads", "inv", "price", "ret"];

// Which Watching group each detector belongs to. Grouping by detector (not by
// action kind) keeps the mapping accurate: the same action (e.g. pause_campaign)
// can be raised by an inventory detector or an ads detector, and it must dock
// into the domain the merchant actually recognises.
const DETECTOR_DOMAIN: Record<string, WatchGroup> = {
  // Ads / spend
  ad_tax_overload: "ads",
  campaign_below_breakeven: "ads",
  campaign_scaling_opportunity: "ads",
  // Inventory / fulfillment
  sku_stockout_vs_spend: "inv",
  regional_shortage_risk: "inv",
  regional_spend_starved_stock: "inv",
  reorder_timing: "inv",
  scaling_sku_fulfillment_risk: "inv",
  wrong_location_concentration: "inv",
  out_of_stock_live: "inv",
  inventory_untracked: "inv",
  // Pricing / margin
  negative_unit_economics: "price",
  margin_erosion: "price",
  cogs_drift: "price",
  priced_below_cost: "price",
  thin_margin: "price",
  missing_cost: "price",
  // Retention / shipping-economics
  return_rate_hidden_loss: "ret",
  free_shipping_leakage: "ret",
};

/** The Watching group a detector belongs to (safe default: ads). */
export function domainForDetector(detectorId: string): WatchGroup {
  return DETECTOR_DOMAIN[detectorId] ?? "ads";
}

function pairKey(detectorId: string, actionKind: string): string {
  return `${detectorId}:${actionKind}`;
}

export function buildFeatureGroups(
  features: LiveEngineFeatureVM[],
  pending: QueueProposalVM[],
): FeatureGroupVM[] {
  const byGroup = new Map<WatchGroup, FeatureRowVM[]>(ORDER.map((g) => [g, []]));
  const seen = new Set<string>();
  const push = (g: WatchGroup, row: FeatureRowVM) => {
    seen.add(pairKey(row.detectorId, row.actionKind));
    byGroup.get(g)!.push(row);
  };

  // graduated, toggleable features (dedup defensively so a repeated
  // (detector, action) can never render two toggles fighting over one pair)
  for (const f of features) {
    if (seen.has(pairKey(f.detectorId, f.actionKind))) continue;
    push(domainForDetector(f.detectorId), {
      detectorId: f.detectorId,
      actionKind: f.actionKind,
      name: f.name,
      enabled: f.enabled,
      locked: false,
      moneyCents: f.moneyCents,
      actions: f.actions,
    });
  }

  // locked, still-learning pairs from the pending queue (deduped, not already graduated)
  for (const p of pending) {
    const key = pairKey(p.detector_id, p.action_kind);
    if (seen.has(key)) continue;
    seen.add(key);
    push(domainForDetector(p.detector_id), {
      detectorId: p.detector_id,
      actionKind: p.action_kind,
      name: ACTION_LABELS[p.action_kind] ?? p.action_kind,
      enabled: false,
      locked: true,
      moneyCents: 0,
      actions: 0,
    });
  }

  // Always return the four groups in fixed order; the hero/rail dim the empties.
  return ORDER.map((g) => {
    const rows = byGroup.get(g) ?? [];
    return {
      key: g,
      label: CATEGORY[g].label,
      icon: CATEGORY[g].icon,
      rows,
      onCount: rows.filter((r) => !r.locked && r.enabled).length,
      total: rows.length,
    };
  });
}

/** Total enabled (on) features across all groups — drives the hero "N active". */
export function countEnabled(groups: FeatureGroupVM[]): number {
  return groups.reduce((n, g) => n + g.onCount, 0);
}

/** Total feature rows across all groups — drives the hex meter denominator. */
export function countTotal(groups: FeatureGroupVM[]): number {
  return groups.reduce((n, g) => n + g.total, 0);
}

/** Watching groups that currently hold a pending (flagged) item. */
export function flaggedGroups(pending: QueueProposalVM[]): Set<WatchGroup> {
  const set = new Set<WatchGroup>();
  for (const p of pending) set.add(domainForDetector(p.detector_id));
  return set;
}
