// Pure mapping from alerts to per-SKU inventory-page actions. Alerts key SKUs
// by their HUMAN sku code (alerts.sku / sku_dim.sku), not the sku_dim uuid —
// the inventory page must join on the code or the join silently matches
// nothing (the bug that left the Alerts column permanently empty).

import type { Alert, DetectorId } from "./types";
import { DETECTOR_TO_ACTIONS } from "./labels";

/** Structural subset shared by the Alert DTO and the dashboard AlertVM. */
export interface AlertActionSource {
  detector_id: string;
  evidence: Record<string, unknown>;
}

export interface InventoryAlertAction {
  kind: "reallocate_inventory" | "snooze_alert" | "create_po_draft";
  /** "execute" = inline from the inventory page; "link" = open the alert detail. */
  mode: "execute" | "link";
}

/** Open alerts grouped by sku code, preserving input order. */
export function openAlertsBySku(alerts: Alert[]): Map<string, Alert[]> {
  const map = new Map<string, Alert[]>();
  for (const a of alerts) {
    if (a.status !== "open" || !a.sku) continue;
    const list = map.get(a.sku) ?? [];
    list.push(a);
    map.set(a.sku, list);
  }
  return map;
}

/** The alert's evidence carries a complete, executable transfer plan. */
function hasTransferPlan(evidence: Record<string, unknown>): boolean {
  const delta = Number(evidence.recommended_delta ?? evidence.delta ?? 0);
  return Boolean(
    evidence.inventory_item_id &&
      evidence.from_location_id &&
      evidence.to_location_id &&
      delta,
  );
}

/**
 * Inventory-page actions for one alert: only kinds the detector allows, and
 * reallocate only when the evidence can actually drive the mutation — an
 * action that would 422 must not render (absence of action, not a dead button).
 */
export function inventoryAlertActions(alert: AlertActionSource): InventoryAlertAction[] {
  const allowed = DETECTOR_TO_ACTIONS[alert.detector_id as DetectorId] ?? [];
  const actions: InventoryAlertAction[] = [];
  if (allowed.includes("reallocate_inventory") && hasTransferPlan(alert.evidence ?? {})) {
    actions.push({ kind: "reallocate_inventory", mode: "execute" });
  }
  if (allowed.includes("create_po_draft")) {
    actions.push({ kind: "create_po_draft", mode: "link" });
  }
  if (allowed.includes("snooze_alert")) {
    actions.push({ kind: "snooze_alert", mode: "execute" });
  }
  return actions;
}
