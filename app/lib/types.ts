// Type definitions for the Calderyn prototype.

export type Severity = "critical" | "high" | "medium" | "low";
export type AlertStatus = "open" | "acknowledged" | "resolved";
export type ActionKind =
  | "pause_campaign"
  | "reduce_campaign_budget"
  | "exclude_geo"
  | "reallocate_inventory"
  | "create_po_draft"
  | "snooze_alert";
export type DetectorId =
  | "ad_tax_overload"
  | "campaign_below_breakeven"
  | "cogs_drift"
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

export interface AuditEntry {
  id: string;
  action_kind: ActionKind;
  outcome: "succeeded" | "failed";
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
}

export interface Campaign {
  id: string;
  name: string;
  platform: "Meta" | "Google";
  status: "active" | "paused";
  daily_budget_cents: number;
  roas_7d: number;
  contribution_margin: number;
  spend_7d: number;
}

export interface SKU {
  id: string;
  title: string;
  on_hand: number;
  days_of_cover: number;
  velocity: number;
  locations: Record<string, number>;
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
}

// --- Ad-spend analytics (session #2). Additive only. ---
export type CampaignGrade = "winning" | "okay" | "poor";

export interface Engagement {
  reactions: number;
  comments: number;
  shares: number;
  saves: number;
  post_engagement: number;
}

export interface CampaignInsight {
  campaign_id: string; // Meta campaign external id
  name: string;
  status: "active" | "paused";
  spend_cents: number;
  impressions: number;
  link_clicks: number;
  purchases: number;
  purchase_value_cents: number;
  roas: number;
  break_even_roas: number;
  grade: CampaignGrade;
  engagement: Engagement;
  linked_alert_ids: string[];
}

export interface AdInsight {
  ad_id: string;
  campaign_id: string;
  name: string;
  spend_cents: number;
  roas: number;
  engagement: Engagement;
}

export interface TrendPoint {
  day_bucket: string; // ISO date
  spend_cents: number;
  roas: number;
}

export type MarginConfidence = "ok" | "low" | "override" | "default";

export interface AnalyticsSummary {
  window_days: 7 | 30 | 90;
  blended_margin_pct: number; // 0..1
  margin_confidence: MarginConfidence;
  break_even_roas: number;
  account_roas: number;
  total_spend_cents: number;
  total_engagement: number; // sum(reactions+comments+shares+saves) over window
}
