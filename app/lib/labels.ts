import type { ActionKind, DetectorId } from "./types";

// Plain-language names shown to merchants. The original analyst term for each
// lives in DETECTOR_TERMS below and is surfaced as a tooltip beside the label,
// so people who know the jargon still get it without it being the headline.
export const DETECTOR_LABELS: Record<DetectorId, string> = {
  ad_tax_overload: "Paying too much in ad fees",
  campaign_below_breakeven: "Campaign is losing money",
  campaign_scaling_opportunity: "Winning campaign you can scale",
  cogs_drift: "Product costs creeping up",
  free_shipping_leakage: "Free shipping costing more than it earns",
  margin_erosion: "Profit per sale shrinking",
  negative_unit_economics: "Losing money on every sale",
  regional_shortage_risk: "About to run out in some areas",
  regional_spend_starved_stock: "Paying for ads where you're out of stock",
  reorder_timing: "Time to reorder",
  return_rate_hidden_loss: "Returns quietly costing you money",
  scaling_sku_fulfillment_risk: "Best-seller may sell out",
  sku_stockout_vs_spend: "Running ads for a sold-out product",
  sku_stockout_cleared: "Sold-out product is back in stock",
  wrong_location_concentration: "Stock in the wrong warehouse",
  out_of_stock_live: "Live product is out of stock",
  inventory_untracked: "Stock not being tracked",
  priced_below_cost: "Selling below cost",
  thin_margin: "Barely making a profit",
  missing_cost: "Add product costs to track profit",
};

// The technical term for each detector — shown as a tooltip/subtitle next to the
// plain label so merchants fluent in the jargon can still map it back.
export const DETECTOR_TERMS: Record<DetectorId, string> = {
  ad_tax_overload: "Ad-tax overload",
  campaign_below_breakeven: "Campaign below breakeven",
  campaign_scaling_opportunity: "Campaign scaling opportunity",
  cogs_drift: "COGS drift",
  free_shipping_leakage: "Free-shipping leakage",
  margin_erosion: "Margin erosion",
  negative_unit_economics: "Negative unit economics",
  regional_shortage_risk: "Regional shortage risk",
  regional_spend_starved_stock: "Regional spend on starved stock",
  reorder_timing: "Reorder timing",
  return_rate_hidden_loss: "Return-rate hidden loss",
  scaling_sku_fulfillment_risk: "Scaling SKU fulfillment risk",
  sku_stockout_vs_spend: "SKU stockout vs spend",
  sku_stockout_cleared: "Stockout cleared",
  wrong_location_concentration: "Wrong location concentration",
  out_of_stock_live: "Out-of-stock live SKU",
  inventory_untracked: "Untracked inventory",
  priced_below_cost: "Priced below cost",
  thin_margin: "Thin margin",
  missing_cost: "Missing cost coverage",
};

// Title-case a raw detector id (e.g. "campaign_scaling_opportunity" → "Campaign
// Scaling Opportunity") so an unmapped id never reaches the UI as snake_case.
function humanizeDetectorId(id: string): string {
  return id.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Canonical merchant-facing detector name (plain English). Both surfaces must
 * use this so the dashboard stops showing the analyst term where the embedded
 * admin shows the plain label (P2-10). Falls back to a humanized id, never raw
 * snake_case.
 */
export function detectorLabel(id: string): string {
  return DETECTOR_LABELS[id as DetectorId] ?? humanizeDetectorId(id);
}

/** The analyst term for a detector (the hover/subtitle jargon). */
export function detectorTerm(id: string): string {
  return DETECTOR_TERMS[id as DetectorId] ?? humanizeDetectorId(id);
}

/**
 * Detector label for a specific alert, made stock-aware: a "best-seller may sell
 * out" alert whose stock / days-of-cover are already 0 is a STOCKOUT, so the
 * label must read "sold out", never "may sell out" — copy must not contradict
 * the evidence on the same screen (P2-11). Evidence values may be strings.
 */
export function alertDetectorLabel(
  id: string,
  evidence: Record<string, unknown> | null | undefined,
): string {
  if (
    id === "scaling_sku_fulfillment_risk" &&
    (Number(evidence?.stock) === 0 ||
      Number(evidence?.on_hand) === 0 ||
      Number(evidence?.days_of_cover) === 0)
  ) {
    return "Best-seller sold out";
  }
  return detectorLabel(id);
}

export const ACTION_LABELS: Record<ActionKind, string> = {
  pause_campaign: "Pause campaign",
  resume_campaign: "Resume campaign",
  reduce_campaign_budget: "Reduce campaign budget",
  increase_campaign_budget: "Scale campaign budget",
  reallocate_budget: "Reallocate budget",
  reallocate_spend_sku: "Move ad budget to a winner",
  exclude_geo: "Exclude geography",
  reallocate_inventory: "Reallocate inventory",
  create_po_draft: "Create PO draft",
  raise_free_ship_threshold: "Raise free-shipping threshold",
  exclude_sku_free_ship: "Exclude SKU from free shipping",
  discontinue_sku: "Stop reordering & archive product",
  adjust_price: "Raise price to restore margin",
  snooze_alert: "Snooze alert",
  push_creative_draft: "Push to Meta as paused draft",
};

// Plain-language name for a (detector, action) autopilot feature. Several
// detectors can resolve to the same action (e.g. three different problems all
// pause a campaign), so naming a feature by its action alone makes those rows
// indistinguishable. This disambiguates the colliding pairs; anything not listed
// falls back to the plain action label.
const FEATURE_LABELS: Record<string, string> = {
  "campaign_below_breakeven:pause_campaign": "Pause money-losing campaigns",
  "negative_unit_economics:pause_campaign": "Pause ads losing money on every sale",
  "sku_stockout_vs_spend:pause_campaign": "Pause ads for sold-out products",
  "sku_stockout_cleared:resume_campaign": "Resume ads when a sold-out product is back in stock",
};

export function featureLabel(detectorId: string, actionKind: ActionKind): string {
  return FEATURE_LABELS[`${detectorId}:${actionKind}`] ?? ACTION_LABELS[actionKind] ?? actionKind;
}

export const ACTION_VERBS: Record<ActionKind, string> = {
  pause_campaign: "Paused campaign",
  resume_campaign: "Resumed campaign",
  reduce_campaign_budget: "Reduced budget",
  increase_campaign_budget: "Scaled budget",
  reallocate_budget: "Reallocated budget",
  reallocate_spend_sku: "Moved ad budget to a winner",
  exclude_geo: "Excluded geo",
  reallocate_inventory: "Reallocated inventory",
  create_po_draft: "Created PO draft",
  raise_free_ship_threshold: "Raised free-ship threshold",
  exclude_sku_free_ship: "Excluded SKU from free shipping",
  discontinue_sku: "Discontinued product",
  adjust_price: "Raised price",
  snooze_alert: "Snoozed alert",
  push_creative_draft: "Pushed paused draft to Meta",
};

// Who acted, in the merchant's terms. Raw actor_user_id values ("merchant",
// "autopilot") read as system internals; unknown values (e.g. a teammate's
// email) pass through via actorLabel below.
export const ACTOR_LABELS: Record<string, string> = {
  merchant: "You",
  "merchant:web-dashboard": "You (dashboard)",
  autopilot: "Autopilot",
  system: "System",
};

export function actorLabel(actor: string): string {
  return ACTOR_LABELS[actor] ?? actor;
}

// Provenance of an audit row's booked-margin figure (see audit-legibility.ts).
export const MARGIN_BASIS_LABELS: Record<string, string> = {
  measured: "Measured from budget change",
  alert_estimate: "Estimated from alert (at-stake)",
  snapshot: "Estimate snapshot",
  none: "No booked margin",
};

// Connected systems a booked-margin input can come from.
export const COST_SOURCE_LABELS: Record<string, string> = {
  quickbooks: "QuickBooks",
  vendor_invoice: "Vendor invoice",
  shopify: "Shopify",
  meta: "Meta",
  google: "Google",
  tiktok: "TikTok",
  unavailable: "source unavailable",
};

// Evidence keys that are raw platform identifiers (Shopify GIDs, internal
// uuids) — plumbing for the action executor, never merchant-facing evidence.
// EvidencePanel suppresses these unconditionally; human-readable *_name
// variants still render. Keep next to EVIDENCE_LABELS so a new detector's
// keys get classified (label vs suppress) in one place.
export const INTERNAL_EVIDENCE_ID_KEYS = [
  "inventory_item_id",
  "from_location_id",
  "to_location_id",
  "location_id",
  "campaign_id",
  "sku_id",
] as const;

// Plain-language labels for evidence keys shown on alert detail pages. Keys
// that aren't in this map fall back to the underscore-stripped/title-cased
// form so a new detector emitting an unknown key still renders sensibly.
export const EVIDENCE_LABELS: Record<string, string> = {
  stock: "Total stock",
  sku_title: "Product",
  title: "Product",
  days_of_cover: "Days until sold out",
  spend_wow_ratio: "Spend vs last week",
  spend_prev_7d_usd: "Spend, prior 7 days",
  spend_this_7d_usd: "Spend, this 7 days",
  spend_7d_usd: "Spend, last 7 days",
  ad_spend_7d_usd: "Ad spend, last 7 days",
  regional_spend_7d_usd: "Regional ad spend, last 7 days",
  cogs_7d_usd: "Product costs, last 7 days",
  revenue_7d_usd: "Revenue, last 7 days",
  revenue_30d_usd: "Revenue, last 30 days",
  return_30d_usd: "Returns, last 30 days",
  gross_profit_7d_usd: "Gross profit, last 7 days",
  velocity_units_per_day: "Selling rate",
  velocity: "Selling rate",
  daily_velocity_units: "Selling rate",
  daily_demand: "Demand per day",
  unit_margin: "Profit per unit",
  unit_margin_usd: "Profit per unit",
  gross_unit_margin_usd: "Gross profit per unit",
  net_per_unit_usd: "Profit after ad costs",
  cac_per_unit_usd: "Ad cost per sale",
  baseline_unit_margin_usd: "Profit per unit (before)",
  current_unit_margin_usd: "Profit per unit (now)",
  current_unit_cost_usd: "Current unit cost",
  prior_unit_cost_usd: "Previous unit cost",
  ad_tax_ratio: "Ad cost share of revenue",
  threshold: "Alert threshold",
  return_rate: "Return rate",
  drift_pct: "Cost increase",
  drop_pct: "Margin drop",
  demand_share_pct: "Sales from this region",
  stock_concentration_pct: "Stock kept in this region",
  margin_pct: "Profit margin",
  baseline_units_30d: "Units sold (30 days)",
  current_units_7d: "Units, last 7 days",
  units_sold_30d: "Units sold, 30 days",
  units_14d: "Units, last 14 days",
  units_30d: "Units, last 30 days",
  gap_days: "Projected stockout window",
  lead_time_days: "Supplier lead time",
  shortfall_units: "Projected shortfall",
  regional_stock_units: "Regional stock",
  regional_stock: "Regional stock",
  stock_elsewhere: "Stock at other locations",
  stock_units: "Stock",
  buffer_units: "Stock needed to resume",
  prepause_spend_7d_usd: "Ad spend before pausing",
  location_region: "Region",
  region: "Region",
  shipping_collected_usd: "Shipping collected from customers",
  ship_cost_usd: "What you paid carriers",
  net_shipping_pnl_usd: "Net shipping P&L",
  free_ship_orders: "Free-shipping orders",
  ship_cost_confidence: "Ship-cost confidence",
  current_free_ship_threshold_usd: "Free-shipping threshold",
  zone: "Shipping zone",
  campaign_name: "Campaign",
  campaign_id: "Campaign",
  inventory_item_id: "Inventory item",
  from_location_id: "From location",
  to_location_id: "To location",
  recommended_delta: "Recommended transfer",
};

// Evidence keys that form a before→after pair. When BOTH are present on an
// alert, EvidencePanel collapses them into one "before → now" row instead of
// two separate cells, so the change reads at a glance. `tone: "critical"` tints
// the "now" value red — these pairs only surface on adverse alerts (cost rising,
// margin shrinking), so the worse number should read as the warning.
export const EVIDENCE_PAIRS: {
  from: string;
  to: string;
  label: string;
  tone?: "critical";
}[] = [
  { from: "prior_unit_cost_usd", to: "current_unit_cost_usd", label: "Unit cost", tone: "critical" },
  { from: "baseline_unit_margin_usd", to: "current_unit_margin_usd", label: "Profit per unit", tone: "critical" },
];

// Acronyms that must stay uppercase when an unknown evidence key falls back to
// title-casing ("cac_per_unit_usd" must never render as "Cac per unit usd").
const LABEL_ACRONYMS = new Set(["cac", "usd", "roas", "sku", "cogs", "po", "aov", "cpc", "cpm", "ctr"]);

/**
 * Fallback label for evidence keys missing from EVIDENCE_LABELS: underscores
 * to spaces, sentence case, acronyms uppercased.
 */
export function formatEvidenceKey(key: string): string {
  if (EVIDENCE_LABELS[key]) return EVIDENCE_LABELS[key];
  const words = key.split("_").map((w) => (LABEL_ACRONYMS.has(w) ? w.toUpperCase() : w));
  const label = words.join(" ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}

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
  daily_demand: (v) => fmtUnits(v, " /day"),
  lead_time_days: (v) => fmtUnits(v, " days"),
  gap_days: (v) => fmtUnits(v, " days"),
  shortfall_units: (v) => fmtUnits(v, " units"),
  regional_stock_units: (v) => fmtUnits(v, " units"),
  regional_stock: (v) => fmtUnits(v, " units"),
  stock_elsewhere: (v) => fmtUnits(v, " units"),
  stock_units: (v) => fmtUnits(v, " units"),
};

const fmtPctFromFraction = (v: unknown): string => {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v ?? "—");
  // Values arrive as fractions (0.493) or already-percent (93.4); treat
  // anything ≤ 1.5 as a fraction.
  const pct = Math.abs(n) <= 1.5 ? n * 100 : n;
  return `${pct.toLocaleString("en-US", { maximumFractionDigits: 1 })}%`;
};

/**
 * Formatter for an evidence value: the explicit per-key entry when present,
 * otherwise inferred from the key's suffix (_usd → money, _pct/_rate/_ratio →
 * percent, _units → units, _days → days) so new detector fields render as
 * "$4,669" / "49%" / "14 days" instead of raw numbers.
 */
export function getEvidenceFormatter(key: string): ((v: unknown) => string) | undefined {
  if (EVIDENCE_FORMATTERS[key]) return EVIDENCE_FORMATTERS[key];
  if (key.endsWith("_usd")) return fmtUsdFromString;
  if (key.endsWith("_pct") || key.endsWith("_rate") || key.endsWith("_ratio")) return fmtPctFromFraction;
  if (key.endsWith("_units")) return (v) => fmtUnits(v, " units");
  if (key.endsWith("_days")) return (v) => fmtUnits(v, " days");
  return undefined;
}

// Action kinds a chat surface may execute after an in-chat confirm tap: the
// alert route can run them with no inputs beyond the alert itself. The rest
// (create_po_draft collects quantity/cost, reallocate_budget lives on the
// Campaigns page) deep-link to their review surface instead. Keep in sync
// with DEEP_LINK_ACTIONS and the PO modal in app/routes/app.alerts.$id.tsx.
export const CHAT_INLINE_ACTIONS: ReadonlySet<ActionKind> = new Set([
  "pause_campaign",
  "reduce_campaign_budget",
  "snooze_alert",
  "exclude_geo",
  "reallocate_inventory",
]);

// Subset of CHAT_INLINE_ACTIONS the WEB DASHBOARD assistant may run inline from
// chat — the kinds DashboardApp.executeAction can fire without a review surface
// (campaign pause/reduce, snooze, reallocate_inventory). exclude_geo is excluded
// here on purpose: it needs a resolved campaign AND a valid region bucket (the
// Alerts review screen gates that before showing its one-click button), so the
// assistant deep-links it to that screen rather than running it blind. Keep in
// sync with executeAction in app/components/dashboard/DashboardApp.tsx.
// (create_po_draft is not chat-inline on any surface — it collects quantity/cost
// on a review surface.)
export const DASH_INLINE_ACTIONS: ReadonlySet<ActionKind> = new Set(
  [...CHAT_INLINE_ACTIONS].filter((k) => k !== "exclude_geo"),
);

// Which dashboard screen reviews a non-inline action's "Review & confirm"
// deep-link. reallocate_budget has no control on the Alerts detail — its budget
// edits live on the Campaigns screen (cut the loser / scale the winner) — so it
// routes there. Every other kind reviews on the Alerts detail (its
// evidence/confirm view, or the create_po_draft PO dialog). Keep in sync with
// review() in app/components/dashboard/AssistantPanel.tsx.
export function dashReviewScreen(kind: ActionKind): "campaigns" | "alerts" {
  return kind === "reallocate_budget" ? "campaigns" : "alerts";
}

export const DETECTOR_TO_ACTIONS: Record<DetectorId, ActionKind[]> = {
  sku_stockout_vs_spend: ["pause_campaign", "reduce_campaign_budget", "exclude_geo", "reallocate_inventory", "snooze_alert"],
  // Slice B: a sold-out product Calderyn auto-paused is back in stock. The only
  // remediation is to resume the campaign it paused (else snooze).
  sku_stockout_cleared: ["resume_campaign", "snooze_alert"],
  free_shipping_leakage: ["raise_free_ship_threshold", "exclude_sku_free_ship", "snooze_alert"],
  campaign_below_breakeven: ["pause_campaign", "reduce_campaign_budget", "snooze_alert"],
  campaign_scaling_opportunity: ["increase_campaign_budget", "snooze_alert"],
  ad_tax_overload: ["reallocate_budget", "reallocate_spend_sku", "reduce_campaign_budget", "pause_campaign", "discontinue_sku", "snooze_alert"],
  margin_erosion: ["adjust_price", "discontinue_sku", "snooze_alert"],
  negative_unit_economics: ["reallocate_spend_sku", "pause_campaign", "reduce_campaign_budget", "discontinue_sku", "snooze_alert"],
  cogs_drift: ["adjust_price", "discontinue_sku", "snooze_alert"],
  regional_shortage_risk: ["reallocate_inventory", "create_po_draft", "snooze_alert"],
  regional_spend_starved_stock: ["exclude_geo", "reallocate_inventory", "snooze_alert"],
  reorder_timing: ["create_po_draft", "snooze_alert"],
  return_rate_hidden_loss: ["pause_campaign", "reduce_campaign_budget", "discontinue_sku", "snooze_alert"],
  scaling_sku_fulfillment_risk: ["create_po_draft", "reallocate_inventory", "snooze_alert"],
  wrong_location_concentration: ["reallocate_inventory", "snooze_alert"],
  // Baseline (catalog/inventory) detectors are informational nudges with no
  // autopilot action — the merchant can only snooze them.
  out_of_stock_live: ["snooze_alert"],
  inventory_untracked: ["snooze_alert"],
  priced_below_cost: ["snooze_alert"],
  thin_margin: ["snooze_alert"],
  missing_cost: ["snooze_alert"],
};

// Campaign-scoped actions are meaningless on an alert with no campaign attached
// (e.g. a SKU-level negative_unit_economics) — never recommend one there (P2-14).
const CAMPAIGN_ACTIONS: ReadonlySet<ActionKind> = new Set([
  "pause_campaign",
  "reduce_campaign_budget",
  "increase_campaign_budget",
  "reallocate_budget",
]);

// Remediation-plan-only executors: discontinue (destructive) and the per-SKU
// budget shift (needs a dedicated mutable campaign + a qualifying winner the
// engine verifies). The coarse recommendedAction hint can't validate either, so
// it never surfaces them — they're offered only via the ranked remediation plan.
const PLAN_ONLY_ACTIONS: ReadonlySet<ActionKind> = new Set([
  "reallocate_spend_sku",
  "discontinue_sku",
  // adjust_price is confirm-only (never autopilot) and needs the live price +
  // COGS to compute a target the coarse hint can't — surfaced only via the
  // ranked remediation plan (review_pricing), never auto-queued.
  "adjust_price",
]);

/**
 * The recommended (default) action for an alert: the first allowed action that
 * is a real fix (not snooze) AND applicable to this alert — a campaign action
 * requires a campaign. Returns null when the only thing left is to snooze/review,
 * so the UI can offer "Review" instead of a meaningless "Pause campaign".
 */
export function recommendedAction(
  detectorId: string,
  opts: { hasCampaign: boolean },
): ActionKind | null {
  const actions = DETECTOR_TO_ACTIONS[detectorId as DetectorId] ?? ["snooze_alert"];
  const firstReal = actions.find(
    (a) =>
      a !== "snooze_alert" &&
      !PLAN_ONLY_ACTIONS.has(a) &&
      (opts.hasCampaign || !CAMPAIGN_ACTIONS.has(a)),
  );
  return firstReal ?? null;
}
