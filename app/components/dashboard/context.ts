// Calderyn DashV2 — the shared `app` context shape passed to every screen.
// DashboardApp builds this object; screens consume it as `{ app }: { app: DashboardCtx }`.
import type { TweakValues } from "./tweaks-panel";
import type {
  AlertVM,
  AuditVM,
  CampaignVM,
  FeedEvent,
  GuardrailVM,
  IntegrationVM,
  OverviewVM,
} from "./view-models";

export type Screen =
  | "dashboard"
  | "alerts"
  | "campaigns"
  | "predictor"
  | "generator"
  | "analytics"
  | "inventory"
  | "audit"
  | "settings";

export interface NavState {
  screen: Screen;
  param: string | null;
}

/** Action kinds an alert can be resolved with (mirrors the prototype). */
export type ActionKind =
  | "pause_campaign"
  | "reduce_campaign_budget"
  | "exclude_geo"
  | "reallocate_inventory"
  | "create_po_draft"
  | "snooze_alert";

export interface DashboardCtx {
  /** Resolved tweak values (theme/layout/type). */
  t: TweakValues;
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
  /** Peer-baseline consent (shops.peer_data_consent); null until loaded. */
  consent: boolean | null;
  overview: OverviewVM | null;

  // --- live engine ---
  feed: FeedEvent[];
  liveOn: boolean;
  setLiveOn: (next: boolean) => void;

  // --- actions ---
  executeAction: (alert: AlertVM, kind: ActionKind) => void;
  undoAction: (entry: AuditVM) => void;
  pushAdDraft: (name: string) => void;

  // --- chrome ---
  toast: (text: string, icon?: string, tone?: string) => void;
  relTime: (ts: number) => string;

  // --- data lifecycle ---
  refresh: () => void;
  loading: boolean;
}
