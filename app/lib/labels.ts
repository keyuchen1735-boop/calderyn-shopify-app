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
  exclude_geo: "Exclude geography",
  reallocate_inventory: "Reallocate inventory",
  create_po_draft: "Create PO draft",
  snooze_alert: "Snooze alert",
};

export const ACTION_VERBS: Record<ActionKind, string> = {
  pause_campaign: "Paused campaign",
  resume_campaign: "Resumed campaign",
  reduce_campaign_budget: "Reduced budget",
  exclude_geo: "Excluded geo",
  reallocate_inventory: "Reallocated inventory",
  create_po_draft: "Created PO draft",
  snooze_alert: "Snoozed alert",
};

// Plain-language labels for evidence keys shown on alert detail pages. Keys
// that aren't in this map fall back to the underscore-stripped/title-cased
// form so a new detector emitting an unknown key still renders sensibly.
export const EVIDENCE_LABELS: Record<string, string> = {
  stock: "Total stock",
  sku_title: "Product",
  days_of_cover: "Days until sold out",
  spend_wow_ratio: "Spend vs last week",
  spend_prev_7d_usd: "Spend, prior 7 days",
  spend_this_7d_usd: "Spend, this 7 days",
  velocity_units_per_day: "Selling rate",
  velocity: "Selling rate",
  unit_margin: "Profit per unit",
  margin_pct: "Profit margin",
  daily_velocity_units: "Selling rate",
  campaign_id: "Campaign",
  inventory_item_id: "Inventory item",
  from_location_id: "From location",
  to_location_id: "To location",
  recommended_delta: "Recommended transfer",
};

const fmtUsdFromString = (v: unknown): string => {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v ?? "—");
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
};

const fmtUnits = (v: unknown, suffix: string): string => {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v ?? "—");
  return `${n.toLocaleString("en-US", { maximumFractionDigits: 1 })}${suffix}`;
};

// Formatters keyed by evidence field name. Unknown keys fall back to the
// EvidencePanel's default toString. Each formatter accepts the raw value
// (number, string, etc.) and returns a display string.
export const EVIDENCE_FORMATTERS: Record<string, (v: unknown) => string> = {
  stock: (v) => fmtUnits(v, " units"),
  days_of_cover: (v) => fmtUnits(v, " days"),
  spend_wow_ratio: (v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return String(v ?? "—");
    // 1.81 → "+81% vs last week"; 0.7 → "-30% vs last week"
    const pct = Math.round((n - 1) * 100);
    const sign = pct >= 0 ? "+" : "";
    return `${sign}${pct}% vs last week`;
  },
  spend_this_7d_usd: fmtUsdFromString,
  spend_prev_7d_usd: fmtUsdFromString,
  velocity_units_per_day: (v) => fmtUnits(v, " /day"),
  velocity: (v) => fmtUnits(v, " /day"),
  daily_velocity_units: (v) => fmtUnits(v, " /day"),
  unit_margin: fmtUsdFromString,
  margin_pct: (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return String(v ?? "—");
    return `${(n * 100).toFixed(0)}%`;
  },
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
