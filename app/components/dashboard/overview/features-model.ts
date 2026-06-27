// Builds the Autopilot-features rail model: graduated features (toggleable) come
// from LiveEnginePageData.features; every other feature in FEATURE_CATALOG renders
// as a "locked" row the shop unlocks as Calderyn learns. The catalog is real
// product capability, not fabricated activity, and is the single source both
// surfaces (this rail + the embedded LiveEngineView) share so they can't drift.
import type { WatchGroup } from "../engine-events";
import type { LiveEngineFeatureVM } from "../../../lib/calibration/live-engine-types";
import type { QueueProposalVM } from "../view-models";

export interface FeatureRowVM {
  detectorId: string;
  actionKind: string;
  name: string;
  enabled: boolean;
  locked: boolean;
  /** Graduated + proven but not yet switched on — show a "Ready to turn on" nudge. */
  recommended: boolean;
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
  sku_stockout_cleared: "inv",
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

export interface CatalogEntry {
  detectorId: string;
  /** The action this feature takes — also the toggle's action once unlocked. */
  actionKind: string;
  /** Plain merchant-facing name. */
  name: string;
  group: WatchGroup;
}

// The full menu of autopilot features Calderyn offers, grouped by domain. Each
// row is a real detector + the action it takes for that problem. A store starts
// with these LOCKED and unlocks them as pairs graduate (proven approvals +
// results): unlocked ones render as live toggles, the rest as locked rows with a
// "learns your store" tooltip. Pure presentation metadata — the locked state is
// the honest "not yet", never fabricated activity.
export const FEATURE_CATALOG: CatalogEntry[] = [
  // Ads & campaigns
  { detectorId: "campaign_below_breakeven", actionKind: "pause_campaign", name: "Pause losing campaigns", group: "ads" },
  { detectorId: "campaign_scaling_opportunity", actionKind: "increase_campaign_budget", name: "Scale winning campaigns", group: "ads" },
  { detectorId: "ad_tax_overload", actionKind: "reduce_campaign_budget", name: "Cut wasted ad spend", group: "ads" },
  // Inventory
  { detectorId: "sku_stockout_vs_spend", actionKind: "pause_campaign", name: "Pause ads for sold-out items", group: "inv" },
  { detectorId: "sku_stockout_cleared", actionKind: "resume_campaign", name: "Resume ads when restocked", group: "inv" },
  { detectorId: "wrong_location_concentration", actionKind: "reallocate_inventory", name: "Move stock where it sells", group: "inv" },
  { detectorId: "regional_shortage_risk", actionKind: "reallocate_inventory", name: "Prevent regional shortages", group: "inv" },
  { detectorId: "regional_spend_starved_stock", actionKind: "pause_campaign", name: "Pause ads in out-of-stock regions", group: "inv" },
  { detectorId: "reorder_timing", actionKind: "create_po_draft", name: "Reorder before you run out", group: "inv" },
  { detectorId: "scaling_sku_fulfillment_risk", actionKind: "reallocate_inventory", name: "Keep best-sellers in stock", group: "inv" },
  { detectorId: "out_of_stock_live", actionKind: "pause_campaign", name: "Catch out-of-stock products", group: "inv" },
  // Pricing & margin
  { detectorId: "negative_unit_economics", actionKind: "pause_campaign", name: "Stop selling at a loss", group: "price" },
  { detectorId: "margin_erosion", actionKind: "adjust_price", name: "Restore lost margin", group: "price" },
  { detectorId: "cogs_drift", actionKind: "adjust_price", name: "Adjust for rising costs", group: "price" },
  { detectorId: "priced_below_cost", actionKind: "adjust_price", name: "Fix below-cost prices", group: "price" },
  { detectorId: "thin_margin", actionKind: "adjust_price", name: "Fix thin margins", group: "price" },
  // Retention & shipping (recommend-only today; shown locked)
  { detectorId: "free_shipping_leakage", actionKind: "raise_free_ship_threshold", name: "Fix costly free shipping", group: "ret" },
  { detectorId: "return_rate_hidden_loss", actionKind: "exclude_sku_free_ship", name: "Cut costly returns", group: "ret" },
];

const CATALOG_BY_DETECTOR = new Map(FEATURE_CATALOG.map((c) => [c.detectorId, c]));

/** Simpler catalog display name for a detector, falling back to the raw label. */
export function catalogName(detectorId: string, fallback: string): string {
  return CATALOG_BY_DETECTOR.get(detectorId)?.name ?? fallback;
}

/** Tooltip shown on a locked feature row, on both surfaces. */
export const LOCKED_FEATURE_TOOLTIP =
  "Unlocked as Calderyn learns your store. Approve or deny its suggestions to unlock more.";

/** Catalog entries in a group the store has not unlocked yet (the locked rows). */
export function lockedCatalogForGroup(
  group: WatchGroup,
  unlockedDetectorIds: Set<string>,
): CatalogEntry[] {
  return FEATURE_CATALOG.filter((c) => c.group === group && !unlockedDetectorIds.has(c.detectorId));
}

export function buildFeatureGroups(features: LiveEngineFeatureVM[]): FeatureGroupVM[] {
  const byGroup = new Map<WatchGroup, FeatureRowVM[]>(ORDER.map((g) => [g, []]));
  const seen = new Set<string>();
  const unlockedDetectors = new Set<string>();

  // Unlocked (graduated) features — real, toggleable. Dedup defensively so a
  // repeated (detector, action) can never render two toggles for one pair.
  for (const f of features) {
    const key = pairKey(f.detectorId, f.actionKind);
    if (seen.has(key)) continue;
    seen.add(key);
    unlockedDetectors.add(f.detectorId);
    byGroup.get(domainForDetector(f.detectorId))!.push({
      detectorId: f.detectorId,
      actionKind: f.actionKind,
      name: catalogName(f.detectorId, f.name),
      enabled: f.enabled,
      locked: false,
      recommended: f.recommended,
      moneyCents: f.moneyCents,
      actions: f.actions,
    });
  }

  // Locked catalog features — everything Calderyn can do that this store has not
  // unlocked yet, so the merchant sees the full menu and what approving
  // suggestions earns them. One catalog entry per detector, skipped once any of
  // that detector's pairs is unlocked above.
  for (const c of FEATURE_CATALOG) {
    if (unlockedDetectors.has(c.detectorId)) continue;
    byGroup.get(c.group)!.push({
      detectorId: c.detectorId,
      actionKind: c.actionKind,
      name: c.name,
      enabled: false,
      locked: true,
      recommended: false,
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
