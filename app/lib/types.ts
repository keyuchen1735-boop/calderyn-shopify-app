// Type definitions for the Calderyn prototype.

import type { ShipCostSource, ShipCostConfidence } from "./ship-cost/types";
import type { RemediationPlan } from "./remediation/types";
import type { CampaignCalderynScore } from "./campaign-score/types";

export type Severity = "critical" | "high" | "medium" | "low";
export type AlertStatus = "open" | "acknowledged" | "resolved";
export type ActionKind =
  | "pause_campaign"
  | "resume_campaign"
  | "reduce_campaign_budget"
  | "increase_campaign_budget"
  | "reallocate_budget"
  | "reallocate_spend_sku"
  | "exclude_geo"
  | "reallocate_inventory"
  | "create_po_draft"
  | "raise_free_ship_threshold"
  | "exclude_sku_free_ship"
  | "discontinue_sku"
  | "adjust_price"
  | "issue_refund"
  | "snooze_alert"
  | "push_creative_draft";
export type DetectorId =
  | "ad_tax_overload"
  | "campaign_below_breakeven"
  | "campaign_scaling_opportunity"
  | "cogs_drift"
  | "free_shipping_leakage"
  | "margin_erosion"
  | "negative_unit_economics"
  | "regional_shortage_risk"
  | "regional_spend_starved_stock"
  | "reorder_timing"
  | "return_rate_hidden_loss"
  | "scaling_sku_fulfillment_risk"
  | "sku_stockout_vs_spend"
  | "sku_stockout_cleared"
  | "wrong_location_concentration"
  | "out_of_stock_live"
  | "inventory_untracked"
  | "priced_below_cost"
  | "thin_margin"
  | "missing_cost";

export interface Alert {
  id: string;
  detector_id: DetectorId;
  severity: Severity;
  status: AlertStatus;
  dollar_impact: number;
  claude_rank: number;
  created_at: string;
  title: string;
  narrative: string;
  campaign: string | null;
  /** ad_campaign_dim uuid for this alert's campaign (resolved by v_alerts_view);
   *  null for non-campaign alerts. Match alerts to campaign rows by this, not name. */
  campaign_id: string | null;
  /** Platform external id of the campaign (Meta/Google/TikTok); used to match
   *  live-Meta campaign rows, which are keyed by external id rather than dim id. */
  campaign_external_id: string | null;
  sku: string | null;
  evidence: Record<string, any>;
  /** Strategic remediation for product-economics detectors (computed on read in
   *  rowToAlert). Null for other detectors. */
  remediation: RemediationPlan | null;
  /** One-to-two sentence plain-language synopsis derived from the remediation
   *  plan. Empty string when there is no plan. */
  rec_detail: string;
}

/** One input that fed an action's booked-margin figure, with its data source.
 *  `kind` is what the input is; `source` is the connected system it came from.
 *  source ∈ "quickbooks" | "vendor_invoice" | "shopify" | "meta" | "google" |
 *  "tiktok" | "unavailable" (when a margin action's COGS source couldn't be resolved). */
export interface CostSource {
  kind: "cogs" | "price" | "ad_spend";
  source: string;
}

export interface AuditEntry {
  id: string;
  action_kind: ActionKind;
  // `retrying` = parked for the action-retry cron (pending, not terminal).
  outcome: "succeeded" | "failed" | "retrying";
  target: string;
  dollar_impact_at_exec: number;
  pre_state: any;
  post_state: any;
  created_at: string;
  actor: string;
  undo_eligible: boolean;
  alert_id: string | null;
  detector_id: DetectorId;
  requires_2fa?: boolean;
  failure_code?: string;
  failure_reason?: string;
  undo_of?: string;
  /** Plain-language reason the autopilot recorded at the decision point.
   *  Null/absent on manual rows — the "why" is derived from the alert instead. */
  trigger_reason?: string | null;
  /** Booked-margin cost-data lineage, resolved server-side in audit.list.
   *  Empty for actions with no margin inputs (snooze, resume). */
  cost_sources?: CostSource[];
}

export interface Campaign {
  id: string;
  name: string;
  platform: "Meta" | "Google" | "TikTok";
  status: "active" | "paused";
  daily_budget_cents: number;
  roas_7d: number;
  contribution_margin: number;
  spend_7d: number;
  /** Blended Calderyn score, attached server-side by the campaigns API loaders. */
  calderynScore?: CampaignCalderynScore | null;
}

/** Platforms that enrich a SKU beyond the Shopify catalog sync:
 * cost data (quickbooks, vendor_invoice) and ad-creative mappings (google, meta, tiktok). */
export type SkuSource =
  | "quickbooks"
  | "vendor_invoice"
  | "google"
  | "meta"
  | "tiktok";

export interface SkuLocationDetail {
  /** Shopify Location GID (location_dim.external_id). */
  id: string;
  name: string;
  region: string | null;
  available: number;
  active: boolean;
}

export interface SkuDemand {
  region: string;
  units_30d: number;
  /** Fraction (0..1) of this SKU's total 30-day demand in that region. */
  share: number;
  stock_in_region: number;
}

export interface SuggestedTransfer {
  inventory_item_id: string;
  from_location_id: string;
  from_location_name: string;
  to_location_id: string;
  to_location_name: string;
  recommended_delta: number;
}

export interface ShopLocation {
  /** Shopify Location GID. */
  id: string;
  name: string;
  region: string | null;
  active: boolean;
}

export interface SKU {
  id: string;
  title: string;
  /** Human SKU code (sku_dim.sku) — the key alerts reference SKUs by. */
  sku: string;
  on_hand: number;
  days_of_cover: number;
  velocity: number;
  locations: Record<string, number>;
  sources: SkuSource[];
  /** null when the SKU has no 30-day sales. */
  demand: SkuDemand | null;
  /** null when no demand/stock mismatch or no viable source+destination. */
  suggested_transfer: SuggestedTransfer | null;
  /** Per-location availability with Shopify GIDs (relocate modal source options). */
  locations_detail: SkuLocationDetail[];
  /** Resolved ship-cost provenance for this SKU's margin — worst/lowest-confidence
   * source among its orders; null until the resolver has run. */
  ship_cost_source: ShipCostSource | null;
  ship_cost_confidence: ShipCostConfidence | null;
  /** Net shipping P&L (shipping collected − true ship cost, last 30d), in cents.
   * Negative = free shipping is bleeding on this SKU; null = no shipped orders
   * in-window. Derived in v_skus_flat. */
  ship_pnl_cents: number | null;
  /** Trailing-30-day gross revenue (cents) over the SAME window as `velocity`,
   * for bestseller ranking. undefined when the sales rollup is unavailable —
   * never fatal. Units sold aren't carried: the velocity column already ranks by
   * volume (units == round(velocity × 30)); the v_sku_sales_30d view still
   * exposes units_30d for future use (e.g. F5 return-rate). ROAS is intentionally
   * omitted: ad spend is campaign-level and can't be reliably attributed to a
   * SKU, so a SKU-level ROAS would be a fabricated number. */
  revenue_30d_cents?: number;
  /** Product facets for inventory slicing (from sku_dim). product_type carries
   * Shopify productType. All optional — undefined/empty when not ingested. */
  vendor?: string | null;
  product_type?: string | null;
  tags?: string[];
  collections?: string[];
  /** Trailing-30-day return rate (refunded units ÷ units sold, same window as
   * velocity). undefined when the SKU had no sales in the window (no
   * divide-by-zero) or no returns. `rate` is 0..1; `returned_units_30d` is the
   * absolute refunded-unit count. */
  returns?: { returned_units_30d: number; rate: number };
  /** Internal "do not reorder" flag — set by discontinue_sku, blocks PO drafts.
   *  Surfaced on the Inventory surface. */
  do_not_reorder: boolean;
}

/** One day's total on-hand for a SKU (sum across locations), for the stock-trend
 * sparkline. `date` is a UTC `YYYY-MM-DD`; points are sparse (only days the SKU
 * had an inventory change), oldest-first. */
export interface SkuHistoryPoint {
  date: string;
  on_hand: number;
}

/** One "frequently bought with" entry for a SKU — a co-purchased SKU over the
 * trailing 90 days. `share` (0..1) is the fraction of the base SKU's orders that
 * also contained this one. Fetched per-SKU (not on the SKU list). */
export interface SkuAffinityItem {
  /** The co-purchased SKU's id (sku_dim.id). */
  sku_id: string;
  title: string;
  co_count: number;
  share: number;
}

export interface Integration {
  name: string;
  // "reauth": paired before, but the stored credential is now dead (e.g. a
  // Google refresh token expired/revoked) — the merchant must reconnect.
  status: "connected" | "pending" | "disconnected" | "reauth";
  detail: string;
  logoCls: string;
}

export interface GuardrailConfig {
  daily_action_budget_cents: number;
  daily_action_budget_used_cents: number;
  dollar_cap_cents: number;
  cooldown_minutes: number;
  business_hours: { start: string; end: string; tz: string };
  in_business_hours: boolean;
  /** When true, actions only execute inside business_hours; else the window is informational. */
  business_hours_only: boolean;
  autopilot_enabled: boolean;
  /** Bypass mode: when true, autopilot skips every safety/rate guardrail (still
   * requires autopilot_enabled). Action size is unchanged. */
  autopilot_bypass_guardrails: boolean;
  /** Max automated actions per UTC day; null = no cap (unlimited). */
  autopilot_daily_action_cap: number | null;
  autopilot_min_spend_cents: number;
  autopilot_max_budget_cut_pct: number;
  autopilot_max_budget_increase_pct: number;
  /** Hard per-campaign daily-budget ceiling for autopilot scale-ups; null = none. */
  autopilot_max_daily_budget_cents: number | null;
  /** Max single-step price change for the adjust_price action, whole percent.
   *  Merchant-facing (adjust_price is confirm-only, never autopilot) — gates how
   *  far one click may move a variant price. */
  max_price_change_pct: number;
  /** Max single-step autonomous price move, whole percent 1..100. Gates the
   *  adjust_price action when autopilot executes it unattended. */
  autopilot_max_price_change_pct: number;
  /** Max units autopilot may move in a single reallocate_inventory action; null
   *  means no unit cap (unlimited). */
  autopilot_max_inventory_units_per_move: number | null;
}

/** Why a merchant rejected a calibration proposal. Used by the feedback
 * module to update Beta counters and emit learned rules. */
export type RejectReason =
  | "too_aggressive"
  | "wrong_timing"
  | "not_enough_data"
  | "i_handle_this"
  | "other";

/** Read-only calibration headline for a shop. Foundation slice: just the
 * cached %; later slices add per-pair detail and trend. */
export interface Calibration {
  pct: number | null;
  updated_at: string | null;
}

// --- Analytics (ad ROAS trend + per-campaign grade + ad engagement) ---

export interface DailyRoasRow {
  day: string; // ISO yyyy-mm-dd
  spend_cents: number;
  revenue_cents: number;
}

export interface CampaignGradeRow {
  campaign_id: string;
  name: string;
  grade: string; // 'winning' | 'okay' | 'poor'
  roas: number;
  break_even_roas: number;
  spend_cents: number;
  revenue_cents: number;
  day_bucket: string;
}

export interface TopAdRow {
  ad_external_id: string;
  ad_name: string;
  campaign_name: string;
  reactions: number;
  comments: number;
  shares: number;
  saves: number;
  engagement: number;
}

/** A learned rule from a merchant rejection — stored in calibration_rule. */
export interface LearnedRule {
  id: string;
  detector_id: string;
  action_kind: ActionKind;
  rule_kind:
    | "pair_dollar_cap"
    | "pair_probation_until"
    | "muted_pair"
    | "pair_blackout_hours"
    | "pair_min_spend"
    | "pair_mu_override";
  summary: string;
  created_at: string;
}

/** One calibrated action proposal for the Action Queue (Calibration Slice 2).
 *  Built from open alerts + pair_calibration Beta counters; returned by
 *  `client.queue.list()`. Confidence is 0-100 (integer). */
export interface QueueProposal {
  alertId: string;
  detector_id: DetectorId;
  action_kind: ActionKind;
  title: string;
  dollar_impact: number;
  /** Calibrated confidence score, 0-100 (integer). */
  confidence: number;
  /** One-line reasoning carried from the alert's narrative. */
  reasoning: string;
  /**
   * I8: true when this is a no-brainer pair that has been muted — it appears
   * in the queue as "always ask" rather than being silently suppressed like a
   * normal muted pair. Absent (undefined) for un-muted proposals.
   */
  always_ask?: boolean;
  /**
   * True when this proposal is on a graduated (autopilot) pair but its specific
   * move exceeds the merchant's autonomy cap, so autopilot blocks it
   * (block-not-clamp) and it needs manual approval. The UI renders an
   * "over your autopilot limit" treatment. Absent for normal proposals.
   */
  over_autopilot_cap?: boolean;
}
