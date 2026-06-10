import type { ActionKind, DetectorId } from "./types";

// Plain-language names shown to merchants. The original analyst term for each
// lives in DETECTOR_TERMS below and is surfaced as a tooltip beside the label,
// so people who know the jargon still get it without it being the headline.
export const DETECTOR_LABELS: Record<DetectorId, string> = {
  ad_tax_overload: "Paying too much in ad fees",
  campaign_below_breakeven: "Campaign is losing money",
  cogs_drift: "Product costs creeping up",
  margin_erosion: "Profit per sale shrinking",
  negative_unit_economics: "Losing money on every sale",
  regional_shortage_risk: "About to run out in some areas",
  regional_spend_starved_stock: "Paying for ads where you're out of stock",
  reorder_timing: "Time to reorder",
  return_rate_hidden_loss: "Returns quietly costing you money",
  scaling_sku_fulfillment_risk: "Best-seller may sell out",
  sku_stockout_vs_spend: "Running ads for a sold-out product",
  wrong_location_concentration: "Stock in the wrong warehouse",
};

// The technical term for each detector — shown as a tooltip/subtitle next to the
// plain label so merchants fluent in the jargon can still map it back.
export const DETECTOR_TERMS: Record<DetectorId, string> = {
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
  resume_campaign: "Resume campaign",
  reduce_campaign_budget: "Reduce campaign budget",
  reallocate_budget: "Reallocate budget",
  exclude_geo: "Exclude geography",
  reallocate_inventory: "Reallocate inventory",
  create_po_draft: "Create PO draft",
  snooze_alert: "Snooze alert",
};

export const ACTION_VERBS: Record<ActionKind, string> = {
  pause_campaign: "Paused campaign",
  resume_campaign: "Resumed campaign",
  reduce_campaign_budget: "Reduced budget",
  reallocate_budget: "Reallocated budget",
  exclude_geo: "Excluded geo",
  reallocate_inventory: "Reallocated inventory",
  create_po_draft: "Created PO draft",
  snooze_alert: "Snoozed alert",
};

export const DETECTOR_TO_ACTIONS: Record<DetectorId, ActionKind[]> = {
  sku_stockout_vs_spend: ["pause_campaign", "reduce_campaign_budget", "exclude_geo", "reallocate_inventory", "snooze_alert"],
  campaign_below_breakeven: ["pause_campaign", "reduce_campaign_budget", "snooze_alert"],
  ad_tax_overload: ["reallocate_budget", "reduce_campaign_budget", "pause_campaign", "snooze_alert"],
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
