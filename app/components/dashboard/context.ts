import type { LiveEnginePageData } from "../../lib/calibration/live-engine-types";
import type { ApproveReceipt } from "../../lib/calibration/delta";
import type {
  AlertVM,
  AuditVM,
  CampaignVM,
  FeedEvent,
  GuardrailVM,
  IntegrationVM,
  OverviewVM,
  QueueProposalVM,
} from "./view-models";

export type Screen =
  | "dashboard"
  | "alerts"
  | "campaigns"
  | "analytics"
  | "inventory"
  | "locations-settings"
  | "audit"
  | "agentic"
  | "settings"
  // Hidden Calderyn Labs "Autopilot replay" demo. Not in the nav rail; reached
  // only via the secret hexagon dot in Settings. Masks itself as Campaigns.
  | "labs"
  // Owned catalog (Slice 1). "catalog" + "collections" ride the nav rail;
  // "product-editor" is an inner flow reached via navigate("product-editor", id|"new").
  | "catalog"
  | "product-editor"
  | "collections"
  // Import from Shopify (#13.promote) — one-click mirror → owned migration.
  | "import-shopify"
  // Go live (Step 9 slice 3) — cutover status, go-live checklist, mode transitions.
  | "cutover";

export interface NavState {
  screen: Screen;
  param: string | null;
}

export interface DashboardTheme {
  dark?: boolean;
  accent?: string;
  density?: string;
  radius?: number;
  glass?: number;
  typeScale?: number;
}

/** Action kinds an alert can be resolved with (mirrors the prototype). */
export type ActionKind =
  | "pause_campaign"
  | "reduce_campaign_budget"
  | "increase_campaign_budget"
  | "exclude_geo"
  | "reallocate_inventory"
  | "create_po_draft"
  | "discontinue_sku"
  | "reallocate_spend_sku"
  | "adjust_price"
  | "snooze_alert";

export interface DashboardCtx {
  t: DashboardTheme;
  /** Shop myshopify domain, for building Shopify admin deep-links. Null for owned (non-Shopify) stores. */
  shopDomain: string | null;
  /** Human-readable store label: display_name, shop_domain, or "Your store" fallback. */
  storeLabel: string;
  /** Current screen + optional route param. */
  nav: NavState;
  /** Navigate to a screen; scrolls main to top. */
  navigate: (screen: Screen, param?: string | null) => void;

  // --- data (view-models, fetched on mount) ---
  alerts: AlertVM[];
  campaigns: CampaignVM[];
  audit: AuditVM[];
  guardrails: GuardrailVM | null;
  integrations: IntegrationVM[];
  /** Replace the shared Connections rows (used by dashboard-native connect /
   *  disconnect mutations so every consumer sees the new state, not just the
   *  Settings screen that ran the mutation). */
  setIntegrations: (rows: IntegrationVM[]) => void;
  /** Peer-baseline consent (shops.peer_data_consent); null until loaded. */
  consent: boolean | null;
  overview: OverviewVM | null;

  // --- live engine ---
  feed: FeedEvent[];
  liveOn: boolean;
  setLiveOn: (next: boolean) => void;

  // --- actions ---
  /** Execute (approve) an action for an alert. Resolves to `{ ok, receipt }`:
   *  `ok` is true ONLY on a real platform success (never on a retrying/failed
   *  outcome — see app/lib/action-outcome.ts), so callers must gate their
   *  "Approved" UI on it; `receipt` is the approve trust receipt on a successful
   *  calibratable action (drives the approve receipt + graduation moment), else
   *  null. The error toast is fired inside executeAction.
   *  opts.newPriceCents is an adjust_price-only merchant override (omit → engine
   *  suggestion); opts.campaignId/loserBudgetCents target the remediation move's
   *  loser campaign for cut_ads on a SKU-level alert (no alert.campaign_id);
   *  opts.poQuantity/poUnitCost carry create_po_draft inputs. Other kinds ignore them. */
  executeAction: (
    alert: AlertVM,
    kind: ActionKind,
    opts?: {
      newPriceCents?: number;
      campaignId?: string;
      loserBudgetCents?: number;
      poQuantity?: string;
      poUnitCost?: string;
    },
  ) => Promise<{ ok: boolean; receipt: ApproveReceipt | null }>;
  undoAction: (entry: AuditVM) => void;
  pushAdDraft: (name: string) => void;

  // --- chrome ---
  toast: (text: string, icon?: string, tone?: string) => void;
  relTime: (ts: number) => string;

  /** Calibration headline; null until loaded or when no data yet. */
  calibration: { pct: number | null; updated_at: string | null; nearGraduation: number } | null;
  /** Re-pull the calibration headline after a teaching signal lands. */
  refreshCalibration: () => void;

  /** Pending proposals surfaced inline on the Overview hero; empty until loaded. */
  actionQueue: QueueProposalVM[];

  /** Live Engine page data (autopilot + pipeline + trace + predictions); null until loaded. */
  liveEngine: LiveEnginePageData | null;

  // --- data lifecycle ---
  refresh: () => void;
  /** Re-pull only the Live Engine bundle (autopilot/trace/predictions) — much
   *  lighter than refresh(), used for the Live Engine's gentle live poll and to
   *  reconcile a single feature-autonomy toggle without refetching everything. */
  refreshLiveEngine: () => void;
  loading: boolean;
}
