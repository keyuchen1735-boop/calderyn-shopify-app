import type { ActionKind, DetectorId } from "./types";

export const DETECTOR_LABELS: Record<DetectorId, string> = {
  ad_tax_overload: "Ad-tax overload",
  campaign_below_breakeven: "Campaign below breakeven",
  cogs_drift: "COGS drift",
  margin_erosion: "Margin erosion",
  negative_unit_economics: "Negative unit economics",
  regional_shortage_risk: "Regional shortage risk",
  regional_spend_starved_stock: "Regional spend on starved stock",
  reorder_timing: "Reorder timing",
  return_rate_hidden_loss: "Return-rate hidden loss",
  scaling_sku_fulfillment_risk: "Scaling SKU fulfillment risk",
  sku_stockout_vs_spend: "SKU stockout vs spend",
  wrong_location_concentration: "Wrong location concentration",
};

export const ACTION_LABELS: Record<ActionKind, string> = {
  pause_campaign: "Pause campaign",
  reduce_campaign_budget: "Reduce campaign budget",
  exclude_geo: "Exclude geography",
  reallocate_inventory: "Reallocate inventory",
  create_po_draft: "Create PO draft",
  snooze_alert: "Snooze alert",
};

export const ACTION_VERBS: Record<ActionKind, string> = {
  pause_campaign: "Paused campaign",
  reduce_campaign_budget: "Reduced budget",
  exclude_geo: "Excluded geo",
  reallocate_inventory: "Reallocated inventory",
  create_po_draft: "Created PO draft",
  snooze_alert: "Snoozed alert",
};

export const DETECTOR_TO_ACTIONS: Record<DetectorId, ActionKind[]> = {
  sku_stockout_vs_spend: ["pause_campaign", "reduce_campaign_budget", "exclude_geo", "reallocate_inventory", "snooze_alert"],
  campaign_below_breakeven: ["pause_campaign", "reduce_campaign_budget", "snooze_alert"],
  ad_tax_overload: ["reduce_campaign_budget", "pause_campaign", "snooze_alert"],
  margin_erosion: ["snooze_alert"],
  negative_unit_economics: ["pause_campaign", "reduce_campaign_budget", "snooze_alert"],
  cogs_drift: ["snooze_alert"],
  regional_shortage_risk: ["reallocate_inventory", "create_po_draft", "snooze_alert"],
  regional_spend_starved_stock: ["exclude_geo", "reallocate_inventory", "snooze_alert"],
  reorder_timing: ["create_po_draft", "snooze_alert"],
  return_rate_hidden_loss: ["pause_campaign", "reduce_campaign_budget", "snooze_alert"],
  scaling_sku_fulfillment_risk: ["create_po_draft", "reallocate_inventory", "snooze_alert"],
  wrong_location_concentration: ["reallocate_inventory", "snooze_alert"],
};
