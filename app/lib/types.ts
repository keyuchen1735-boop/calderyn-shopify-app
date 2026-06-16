// Type definitions for the Calderyn prototype.

export type Severity = "critical" | "high" | "medium" | "low";
export type AlertStatus = "open" | "acknowledged" | "resolved";
export type ActionKind =
  | "pause_campaign"
  | "resume_campaign"
  | "reduce_campaign_budget"
  | "increase_campaign_budget"
  | "reallocate_budget"
  | "exclude_geo"
  | "reallocate_inventory"
  | "create_po_draft"
  | "raise_free_ship_threshold"
  | "exclude_sku_free_ship"
  | "snooze_alert";
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
  | "wrong_location_concentration";

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
  sku: string | null;
  evidence: Record<string, any>;
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
  ship_cost_source: import("./ship-cost/types").ShipCostSource | null;
  ship_cost_confidence: import("./ship-cost/types").ShipCostConfidence | null;
}

export interface Integration {
  name: string;
  status: "connected" | "pending" | "disconnected";
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
  autopilot_enabled: boolean;
  autopilot_daily_action_cap: number;
  autopilot_min_spend_cents: number;
  autopilot_max_budget_cut_pct: number;
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
