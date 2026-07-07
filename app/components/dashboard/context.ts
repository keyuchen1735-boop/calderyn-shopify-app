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
  | "cutover"
  // Autopilot — the trust ladder / calibration surface, promoted to a screen.
  | "autopilot"
  // Owned commerce surfaces (RUN group).
  | "orders"
  | "customers"
  | "shipping"
  | "payments"
  // Purchase orders + stock transfers — Products subtabs with their own URLs.
  | "products-po"
  | "products-transfers"
  // Store studio (BUILD group) — draft/publish editor over page_document.
  | "storefront"
  // Viral product sourcing (BUILD group, under Store) - /dashboard/store/discover
  | "discover";

export interface NavState {
  screen: Screen;
  param: string | null;
  /** Subtab within the screen (e.g. orders → "labels"); null when the screen
   *  has no subtabs or is on its default tab. Encoded in the URL by routes.ts. */
  sub: string | null;
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
  /** Public dashboard origin where OAuth callback cookies live. Empty in single-host dev. */
  authBase?: string;
  /** Shop myshopify domain, for building Shopify admin deep-links. Null for owned (non-Shopify) stores. */
  shopDomain: string | null;
  /** Human-readable store label: display_name, shop_domain, or "Your store" fallback. */
  storeLabel: string;
  /** True for seeded demo shops (shops.demo_mode) — gates the Settings demo-reset card. */
  demoMode: boolean;
  /** True for first-party (email / Google) accounts — gates the Settings
   *  "Danger zone" self-delete card. Legacy Shopify sessions have no users row. */
  canDeleteAccount: boolean;
  /** Server-side hint from the route loader: the shop has at least one catalog
   *  product. Decides Home's FIRST paint (established layout vs setup guide)
   *  before the client's catalog fetch confirms — the fetch stays authoritative
   *  once it lands. */
  hasCatalog: boolean;
  /** Current screen + optional route param. */
  nav: NavState;
  /** Navigate to a screen; pushes the dedicated URL and scrolls main to top.
   *  opts.preserveScroll keeps the pane where it is — for in-place expansions
   *  (an alert row opening its detail) where jumping to top would lose the
   *  row the user just clicked. */
  navigate: (
    screen: Screen,
    param?: string | null,
    sub?: string | null,
    opts?: { preserveScroll?: boolean },
  ) => void;

  /** Flip night mode (persisted). The shell owns the state; this setter lets
   *  Settings render the design's "Dark mode" row as a real control. */
  setNightMode: (next: boolean) => void;

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
  /** Act on a weather prediction (Weather tab or its mirrored alert): apply
   *  now, arm for weather-triggered execution, or dismiss. Owns the API call,
   *  the toasts, resolving the mirrored alert locally, and the Customers
   *  session-cache write-through. Resolves false on failure so callers can
   *  roll back optimistic UI. */
  weatherIntent: (suggestionId: string, intent: "apply" | "arm" | "dismiss") => Promise<boolean>;
  pushAdDraft: (name: string) => void;

  // --- chrome ---
  toast: (text: string, icon?: string, tone?: string) => void;
  relTime: (ts: number) => string;
  /** Open the Ask Calderyn assistant panel (same panel the sidebar button
   *  opens). Home's prompt bar and the global ⌘K shortcut ride this. With
   *  `prompt`, the panel opens AND sends the text as the next user turn —
   *  the page bar is an entry point; the conversation lives in the panel. */
  openAssistant: (prompt?: string) => void;

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
  /** True once a load has completed with EVERY slice applied. Distinct from
   *  !loading: a failed boot also flips loading off, but must not be presented
   *  as a complete picture — honest empty-states ("All clear", "standing by")
   *  key off `booted` so they can never be claimed off missing data. */
  booted: boolean;
}
