// Builds the Autopilot-features rail model from REAL data: graduated features
// (toggleable) come from LiveEnginePageData.features; "locked" rows are distinct
// (detector, action) pairs the shop is still learning, surfaced from the pending
// Action Queue — nothing here is fabricated. The hero's hex meter and the rail
// share this model so their counts always agree.
import { ACTION_LABELS } from "../format";
import { groupForActionKind } from "../hero/hero-motion";
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

function pairKey(detectorId: string, actionKind: string): string {
  return `${detectorId}:${actionKind}`;
}

export function buildFeatureGroups(features: LiveEngineFeatureVM[], pending: QueueProposalVM[]): FeatureGroupVM[] {
  const byGroup = new Map<WatchGroup, FeatureRowVM[]>();
  const seen = new Set<string>();
  const push = (g: WatchGroup, row: FeatureRowVM) => {
    seen.add(pairKey(row.detectorId, row.actionKind));
    byGroup.set(g, [...(byGroup.get(g) ?? []), row]);
  };

  // graduated, toggleable features
  for (const f of features) {
    push(groupForActionKind(f.actionKind), {
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
    push(groupForActionKind(p.action_kind), {
      detectorId: p.detector_id,
      actionKind: p.action_kind,
      name: ACTION_LABELS[p.action_kind] ?? p.action_kind,
      enabled: false,
      locked: true,
      moneyCents: 0,
      actions: 0,
    });
  }

  return ORDER.filter((g) => byGroup.has(g)).map((g) => {
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
  for (const p of pending) set.add(groupForActionKind(p.action_kind));
  return set;
}
