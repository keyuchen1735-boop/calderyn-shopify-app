// Tips are shared with the screener engine; reuse its (string | {title,detail})
// union so legacy string tips and structured tips both flow through unchanged.
import type { Tip } from "~/lib/screener/types";
import type { CostSource } from "~/lib/types";
import type { StateDiffRow } from "~/lib/audit-state-diff";
import type {
  ShipCostSource,
  ShipCostConfidence,
} from "~/lib/ship-cost/types";
import type { RemediationPlan } from "~/lib/remediation/types";
export type { Tip, TipDetail } from "~/lib/screener/types";

export type Severity = "critical" | "high" | "medium" | "low";
export type Platform = "Meta" | "Google" | "TikTok";
export type Grade = "winning" | "okay" | "poor" | "nodata";
/** Platforms enriching a SKU beyond the Shopify sync (mirrors lib/types SkuSource). */
export type SkuSource = "quickbooks" | "vendor_invoice" | "google" | "meta" | "tiktok";

export interface CampaignVM {
  id: string;
  name: string;
  platform: Platform;
  status: string;
  daily_budget_cents: number;
  spend_7d: number;
  roas_7d: number;
  breakeven_roas: number;
  contribution_margin: number;
  grade: Grade;
  /** No per-campaign series exists yet. TODO(api): per-campaign roas series. */
  trend?: number[];
}

export interface AlertVM {
  id: string;
  detector_id: string;
  severity: Severity;
  status: string;
  claude_rank: number;
  dollar_impact: number;
  created_at: string;
  title: string;
  campaign: string | null;
  campaign_id: string | null;
  sku: string | null;
  narrative: string;
  evidence: Record<string, string>;
  actions: string[];
  /** Action kinds with no executor that deep-link to a manual destination
   *  (e.g. free-shipping → Shopify Shipping settings). Rendered as links, not
   *  execute buttons (rule 12). The href is built at render time from the shop. */
  deepLinkKinds?: string[];
  recommended: string | null;
  rec_detail: string;
  remediation: RemediationPlan | null;
}

export interface AuditVM {
  id: string;
  action_kind: string;
  verb: string;
  target: string;
  detail: string;
  dollar_impact_at_exec: number;
  outcome: string;
  actor: string;
  when: string;
  /** Raw ISO timestamp, for windowing (e.g. Recovered 7d). `when` is for display. */
  created_at: string;
  undo_eligible: boolean;
  /** Audit id this row undoes, when the row is itself an undo. */
  undo_of: string | null;
  pre: string;
  post: string;
  failure?: string;
  /** Merchant-safe version of `failure`; the raw `failure` stays for the
   *  details expansion (P2-12). */
  failureFriendly?: string;
  /** Legibility signals derived once in audit-legibility.ts (parity with the
   *  extension). Rendered in the dashboard's own primitives. */
  mode: "auto" | "manual";
  actorDisplay: string;
  marginBasis: string;
  marginBasisLabel: string;
  costLineage: CostSource[];
  why: string;
  whyDetail?: string;
  /** Human before→after rows for the detail panel (shared with the extension). */
  stateDiff: StateDiffRow[];
}

export interface SkuVM {
  id: string;
  title: string;
  sku: string;
  category: string;
  on_hand: number;
  days_of_cover: number;
  velocity: number;
  /** Projected sell-out date (ISO `YYYY-MM-DD`); null when the SKU has no
   * recent sales (days-of-cover isn't meaningful). Mirrors the extension. */
  projected_stockout: string | null;
  /** Trailing-30-day gross revenue (cents) for bestseller ranking; undefined when
   * the sales rollup is unavailable. Mirrors the extension's SKU. */
  revenue_30d_cents?: number;
  /** Product facets for inventory slicing (product_type = Shopify productType).
   * Mirrors the extension's SKU; undefined/empty when not ingested. */
  vendor?: string | null;
  product_type?: string | null;
  tags?: string[];
  collections?: string[];
  /** Trailing-30-day return rate (refunded units ÷ units sold); undefined when
   * the SKU had no sales in the window or no returns. `rate` is 0..1. Mirrors
   * the extension's SKU. */
  returns?: { returned_units_30d: number; rate: number };
  status: string;
  locations: Record<string, number>;
  sources: SkuSource[];
  /** Top demand region over the last 30 days; null when the SKU has no sales. */
  demand: { region: string; units_30d: number; share: number; stock_in_region: number } | null;
  /** Concrete transfer plan; null when no demand/stock mismatch exists. */
  suggested_transfer: {
    from_location_id: string;
    from_location_name: string;
    to_location_id: string;
    to_location_name: string;
    recommended_delta: number;
  } | null;
  /** Per-location availability with Shopify GIDs (relocate dialog options). */
  locations_detail: Array<{
    id: string;
    name: string;
    region: string | null;
    available: number;
    active: boolean;
  }>;
  /** Worst/lowest-confidence ship-cost provenance among this SKU's orders; null
   * until the resolver has run. Mirrors the Shopify-side SKU badge. */
  ship_cost_source: ShipCostSource | null;
  ship_cost_confidence: ShipCostConfidence | null;
  /** Net shipping P&L for this SKU (shipping collected − true ship cost, last
   * 30d), in cents. Negative = free shipping is bleeding. null = no shipped
   * orders in-window. */
  ship_pnl_cents: number | null;
  /** Internal "do not reorder" flag — set by discontinue_sku, blocks PO drafts.
   *  Surfaced on the Inventory surface as a "Won't reorder" pill. */
  do_not_reorder: boolean;
}

export interface GuardrailVM {
  daily_action_budget_cents: number;
  daily_action_budget_used_cents: number;
  dollar_cap_cents: number;
  cooldown_minutes: number;
  business_hours: { start: string; end: string; tz: string };
  in_business_hours: boolean;
  business_hours_only: boolean;
  autopilot_enabled: boolean;
  /** Bypass mode: when true, autopilot skips every safety/rate guardrail. */
  autopilot_bypass_guardrails: boolean;
  /** Max automated actions per day; null = no cap (unlimited). */
  autopilot_daily_action_cap: number | null;
  autopilot_actions_today: number;
  autopilot_min_spend_cents: number;
  autopilot_max_budget_cut_pct: number;
  autopilot_max_budget_increase_pct: number;
  autopilot_max_daily_budget_cents: number | null;
  /** Max single-step price change for the adjust_price action, whole percent. */
  max_price_change_pct: number;
}

export interface DailyRow {
  daysAgo: number;
  spend_cents: number;
  revenue_cents: number;
}

export interface OverviewVM {
  roas_series: DailyRow[];
  campaign_count: number;
  active_campaign_count: number;
  open_alert_count: number;
  open_alert_dollar_impact_cents: number;
}

export interface IntegrationVM {
  key: string;
  name: string;
  status: string;
  detail: string;
  logoCls: string;
}

export interface TopAd {
  ad_name: string;
  campaign_name: string;
  reactions: number;
  comments: number;
  shares: number;
  saves: number;
  engagement: number;
}

export interface ScorecardMetric {
  id: string;
  group: string;
  label: string;
  score: number;
  reasoning: string;
}

export interface ScorecardVariant {
  mode: string;
  composite: number;
  delta: number;
  summary: string;
  headline: string;
  cta: string;
}

export interface Scorecard {
  ad_name: string;
  composite: number;
  grade: Grade;
  confidence: string;
  summary: string;
  outcomes: {
    estimatedRoas: number;
    roasLow: number;
    roasHigh: number;
    breakEvenRoas: number;
    predictedCtr: number;
    holdRate: number;
    assumedSpendCents: number;
    predictedRevenueCents: number;
    mappedSku: string;
    skuPriceCents: number;
  };
  metrics: ScorecardMetric[];
  tips: Tip[];
  variants: ScorecardVariant[];
}

export interface GeneratorFix {
  dim: string;
  before: number;
  fix: string;
}

export interface GeneratorOutput {
  id: string;
  recommended: boolean;
  name: string;
  format: string;
  duration: string | null;
  headline: string;
  primaryText: string;
  cta: string;
  composite: number;
  delta: number;
  estRoas: number;
  fixed: Array<[string, number, number]>;
}

export interface Generator {
  source_ad: string;
  source_composite: number;
  fixes: GeneratorFix[];
  styles: string[];
  steps: string[];
  outputs: GeneratorOutput[];
}

export interface FeedEvent {
  id?: string | number;
  icon: string;
  text: string;
  sub: string;
  tone: string;
  cents: number;
  kind?: string;
  /** Epoch ms the event was surfaced; stamped at push time, read via app.relTime. */
  ts?: number;
}

export interface Toast {
  id: string | number;
  text: string;
  icon?: string;
  tone?: string;
}

export interface Tweaks {
  [key: string]: unknown;
}

/** Dashboard view-model for a single action-queue proposal. */
export interface QueueProposalVM {
  alertId: string;
  detector_id: string;
  action_kind: string;
  title: string;
  dollar_impact: number;
  /** Calibrated confidence, 0-100. */
  confidence: number;
  /** One-line reasoning from the alert narrative. */
  reasoning: string;
}

/** Dashboard view-model for a single learned calibration rule.
 *  Mirrors LearnedRule in ~/lib/types.ts; carries a plain-language summary
 *  computed server-side via ruleSummary(). */
export interface LearnedRuleVM {
  id: string;
  detector_id: string;
  action_kind: string;
  rule_kind: "pair_dollar_cap" | "pair_probation_until" | "muted_pair";
  summary: string;
  created_at: string;
}
