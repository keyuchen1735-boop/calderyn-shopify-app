// app/lib/dashboard/client.ts
//
// Browser-only data layer for the dashboard SPA. Fetches the /dashboard/api/*
// endpoints and adapts the raw API JSON (app/lib/types.ts) into the view-models
// the screens consume (app/components/dashboard/view-models.ts).
//
// This module is client-only: it uses fetch, crypto.randomUUID(), and
// location.origin. It MUST NOT import any *.server.ts module.

import { runBulkInChunks } from "./orders-client";
import type { LiveAnalyticsSnapshot } from "./live-analytics-types";
import type { CatalogSort } from "~/lib/catalog/catalog-sort";
import type { SeoListingVM } from "~/lib/catalog/types";
import type { ListingDraftCurrent, ListingPlan } from "~/lib/catalog/listing-prompt";
import type {
  Alert,
  AuditEntry,
  Campaign,
  CampaignGradeRow,
  DailyRoasRow,
  GuardrailConfig,
  Integration,
  LearnedRule,
  RejectReason,
  SkuAffinityItem,
  TopAdRow,
} from "~/lib/types";
import type {
  AlertVM,
  AuditVM,
  CampaignVM,
  DailyRow,
  GuardrailVM,
  IntegrationVM,
  LearnedRuleVM,
  OverviewVM,
  QueueProposalVM,
  TopAd,
} from "~/components/dashboard/view-models";
import type { LiveEnginePageData } from "~/lib/calibration/live-engine-types";
import type { ApproveReceipt } from "~/lib/calibration/delta";
import { DETECTOR_TO_ACTIONS, recommendedAction } from "~/lib/labels";
import { hasTransferPlan } from "~/lib/inventory-alerts";
import { collectionHandle } from "~/lib/catalog/handle";
import { hasActionDeepLink } from "~/lib/action-deeplinks";
import { isValidRegion, type RegionCode } from "~/lib/ads/actions";
import { gradeFromRow } from "~/lib/campaign-grade";
import { friendlyActionError, displayAuditTarget } from "~/lib/friendly-error";
import { auditLegibility } from "~/lib/audit-legibility";
import { stateDiff } from "~/lib/audit-state-diff";
import type { CreativeScreenRun, ScoreCard, CreativeInput, Variant } from "~/lib/screener/types";
import type {
  ChatMessage as AssistantMessage,
  ConversationSummary as AssistantConversation,
} from "~/lib/assistant/types";
import type { ActionReceipt } from "~/lib/assistant/actions/registry-types";

// --- error type ------------------------------------------------------------

export class DashboardApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** For 502 action_failed responses, the audit row id of the failed attempt. */
  readonly auditId?: string;

  constructor(status: number, code: string, message: string, auditId?: string) {
    super(message);
    this.name = "DashboardApiError";
    this.status = status;
    this.code = code;
    this.auditId = auditId;
  }
}

// --- low-level fetchers ----------------------------------------------------

interface ApiErrorBody {
  error?: string;
  message?: string;
  audit_id?: string;
}

async function parseErrorBody(res: Response): Promise<ApiErrorBody> {
  try {
    return (await res.json()) as ApiErrorBody;
  } catch {
    return {};
  }
}

async function toApiError(res: Response): Promise<DashboardApiError> {
  const body = await parseErrorBody(res);
  const code = body.error ?? `http_${res.status}`;
  const message = body.message ?? body.error ?? res.statusText ?? "Request failed";
  return new DashboardApiError(res.status, code, message, body.audit_id);
}

// A 401 means the dashboard session is gone (expired/revoked/not sent). Sending
// the user to re-login is the only real recovery — toasting it as a data error
// or (in the poller) swallowing it just leaves a dead, looping dashboard. Guard
// so the live poller's parallel fan-out triggers a single navigation, not one
// per in-flight request.
let redirectingToLogin = false;
function redirectToLogin(): void {
  // Latch only when we actually navigate, so a no-op environment (SSR, tests)
  // can't trip the guard and suppress a real later redirect.
  if (redirectingToLogin || typeof location === "undefined") return;
  redirectingToLogin = true;
  // Straight to the login page with the session-expired copy: routing through
  // /dashboard/signin would redirect to /login anyway, but drop the message.
  location.assign("/login?error=session_expired");
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(path, {
    method: "GET",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
  });
  if (res.status === 401) redirectToLogin();
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as T;
}

export async function apiSend<T>(
  method: "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      // The API's requireSameOrigin allowlists the apex/app origins; sending
      // our own origin lets same-origin browser requests pass the CSRF guard.
      Origin: location.origin,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) redirectToLogin();
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as T;
}

/** POST multipart FormData with the same-origin + CSRF conventions apiSend uses,
 *  but WITHOUT a Content-Type header so the browser sets the multipart boundary
 *  (same rule as uploadProductImage). Errors parse to a DashboardApiError with
 *  the server's code/message, like apiSend. */
export async function apiSendForm<T>(path: string, form: FormData): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { Origin: location.origin },
    body: form,
  });
  if (res.status === 401) redirectToLogin();
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as T;
}

// --- adapters --------------------------------------------------------------

/**
 * `DailyRoasRow[]` arrives oldest→newest. Map to DailyRow with a `daysAgo`
 * offset where the last (newest) row is today (0). Order is preserved.
 */
export function adaptDaily(rows: DailyRoasRow[]): DailyRow[] {
  const last = rows.length - 1;
  return rows.map((r, i) => ({
    daysAgo: last - i,
    spend_cents: r.spend_cents,
    revenue_cents: r.revenue_cents,
  }));
}

export function adaptAlert(a: Alert, campaigns: CampaignVM[]): AlertVM {
  // Prefer the campaign dim id resolved by v_alerts_view (robust against two
  // campaigns sharing a name); fall back to a name match only for older rows
  // that predate the campaign_id column.
  // The campaign this alert is *scoped* to: the dim id from v_alerts_view (robust
  // against two campaigns sharing a name), or a name match for older rows. Drives
  // whether the alert counts as campaign-scoped when picking the recommended
  // action — parity with the Autopilot queue's hasCampaign.
  const campaign_id =
    a.campaign_id ??
    (a.campaign != null ? campaigns.find((c) => c.name === a.campaign)?.id ?? null : null);

  // A SKU-scoped alert (e.g. sku_stockout_vs_spend) can still name the offending
  // campaign in its evidence — a real ad_campaign_dim id. Use it to make the
  // campaign fix executable without treating the alert as campaign-scoped.
  const evRaw = (a.evidence as Record<string, unknown> | null) ?? {};
  const evidenceCampaignId =
    typeof evRaw.campaign_id === "string" && evRaw.campaign_id ? evRaw.campaign_id : null;
  const execCampaignId = campaign_id ?? evidenceCampaignId;

  // exclude_geo drops one of the four internal region buckets from a campaign's
  // targeting (executor contract). The engine also emits finer state-form regions
  // (e.g. "US-TX") in some evidence; those are NOT buckets, so a non-bucket value
  // leaves exclude_geo as the Ads-Manager deep-link rather than a button that 422s.
  const regionRaw = evRaw.region;
  const region = isValidRegion(regionRaw) ? regionRaw : undefined;

  // Live-executable kinds render as buttons: campaign kinds (incl. exclude_geo)
  // go through /dashboard/api/campaigns/:id/action, reallocate_inventory through
  // /dashboard/api/alerts/:id/action.
  const detectorActions = DETECTOR_TO_ACTIONS[a.detector_id] ?? [];
  // exclude_geo is executable only with a resolvable campaign AND a valid bucket;
  // otherwise it stays a deep-link (below).
  const canExcludeGeo =
    Boolean(execCampaignId) && detectorActions.includes("exclude_geo") && Boolean(region);
  // reallocate_inventory 422s without a complete transfer plan in evidence, so it
  // is offered only when the evidence can actually drive the mutation — never a
  // dead button (rule 12). Same gate the inventory page and Autopilot queue use.
  const canReallocate = detectorActions.includes("reallocate_inventory") && hasTransferPlan(evRaw);
  // Campaign kinds need a resolvable campaign AND must be valid for the detector —
  // a winning-campaign (scaling) alert offers increase, never pause/reduce.
  const actions: string[] = [
    ...(execCampaignId && detectorActions.includes("pause_campaign") ? ["pause_campaign"] : []),
    ...(execCampaignId && detectorActions.includes("reduce_campaign_budget") ? ["reduce_campaign_budget"] : []),
    ...(execCampaignId && detectorActions.includes("increase_campaign_budget") ? ["increase_campaign_budget"] : []),
    ...(canExcludeGeo ? ["exclude_geo"] : []),
    ...(canReallocate ? ["reallocate_inventory"] : []),
    ...(detectorActions.includes("create_po_draft") ? ["create_po_draft"] : []),
    "snooze_alert",
  ];

  // The recommended action is the detector's calibrated default (the same source
  // the Autopilot queue uses via recommendedAction), narrowed to what is actually
  // runnable on THIS alert. If the default can't run here, recommend nothing so
  // the UI shows "Review" — never a dead button, never a cross-surface
  // disagreement where Alerts recommends a move Autopilot would not (rule 12).
  const defaultAction = recommendedAction(a.detector_id, { hasCampaign: Boolean(campaign_id) });
  const recommended = defaultAction && actions.includes(defaultAction) ? defaultAction : null;

  // Detector kinds with no executor but a manual destination (e.g. free-shipping
  // → Shopify Shipping settings) surface as deep-links, not dead buttons (rule 12).
  // exclude_geo is dropped from the deep-links once it's a live button so it never
  // double-surfaces as both a button and a link.
  const deepLinkKinds = detectorActions.filter(
    (k) => hasActionDeepLink(k) && !(k === "exclude_geo" && canExcludeGeo),
  );

  // Evidence values may arrive as non-strings; coerce so AlertVM's
  // Record<string,string> contract holds.
  const evidence: Record<string, string> = {};
  for (const [k, v] of Object.entries(a.evidence ?? {})) {
    evidence[k] = typeof v === "string" ? v : String(v);
  }

  return {
    id: a.id,
    detector_id: a.detector_id,
    severity: a.severity,
    status: a.status,
    claude_rank: a.claude_rank,
    dollar_impact: a.dollar_impact,
    created_at: a.created_at,
    title: a.title,
    narrative: a.narrative,
    campaign: a.campaign,
    sku: a.sku,
    evidence,
    // The executable campaign for this alert's campaign actions — the scoped
    // campaign, or the one named in evidence for a SKU-scoped alert.
    campaign_id: execCampaignId,
    region,
    actions,
    deepLinkKinds,
    recommended,
    rec_detail: a.rec_detail ?? "",
    remediation: a.remediation ?? null,
  };
}

export function adaptCampaign(c: Campaign, grades: CampaignGradeRow[]): CampaignVM {
  const g = grades.find((row) => row.campaign_id === c.id);
  const breakeven_roas = g?.break_even_roas ?? 0;
  // Single grade source (P1-6): "nodata" when the grade row has spend but no
  // attributed revenue, so an attribution gap never renders as "poor".
  const grade = gradeFromRow(g ?? { roas: c.roas_7d, break_even_roas: breakeven_roas }, c.roas_7d);

  return {
    id: c.id,
    name: c.name,
    platform: c.platform,
    status: c.status,
    daily_budget_cents: c.daily_budget_cents,
    spend_7d: c.spend_7d,
    // Coerce non-finite live values to 0 so the screen's `.toFixed(1)` calls
    // can't throw on a null/undefined ROAS or margin from a partial API row.
    roas_7d: Number.isFinite(c.roas_7d) ? c.roas_7d : 0,
    contribution_margin: Number.isFinite(c.contribution_margin) ? c.contribution_margin : 0,
    breakeven_roas,
    grade,
    // TODO(api): per-campaign roas series — no per-campaign trend exists yet.
    trend: undefined,
    calderynScore: c.calderynScore ?? null,
  };
}

const AUDIT_VERBS: Record<string, string> = {
  pause_campaign: "Paused campaign",
  resume_campaign: "Resumed campaign",
  reduce_campaign_budget: "Reduced budget",
  reallocate_budget: "Reallocated budget",
  exclude_geo: "Excluded geo",
  reallocate_inventory: "Reallocated inventory",
  create_po_draft: "Created PO draft",
  snooze_alert: "Snoozed alert",
  push_creative_draft: "Pushed paused draft to Meta",
};

/** Stringify a pre/post state blob into a succinct one-liner, or "—". */
function summarizeState(state: unknown): string {
  if (state == null) return "—";
  if (typeof state === "string") return state;
  if (typeof state === "number" || typeof state === "boolean") return String(state);
  try {
    const json = JSON.stringify(state);
    if (!json || json === "{}" || json === "[]") return "—";
    return json;
  } catch {
    return "—";
  }
}

export function adaptAudit(e: AuditEntry): AuditVM {
  const leg = auditLegibility(e);
  return {
    id: e.id,
    action_kind: e.action_kind,
    verb: AUDIT_VERBS[e.action_kind] ?? e.action_kind,
    target: displayAuditTarget(e.target),
    detail: e.failure_reason ?? "",
    dollar_impact_at_exec: e.dollar_impact_at_exec,
    outcome: e.outcome,
    actor: e.actor,
    // The screen formats the timestamp; pass the raw ISO string through.
    when: e.created_at,
    created_at: e.created_at,
    undo_eligible: e.undo_eligible,
    undo_of: e.undo_of ?? null,
    pre: summarizeState(e.pre_state),
    post: summarizeState(e.post_state),
    failure: e.failure_reason,
    failureFriendly: friendlyActionError(e.failure_reason) ?? undefined,
    mode: leg.mode,
    actorDisplay: leg.actorDisplay,
    marginBasis: leg.marginBasis,
    marginBasisLabel: leg.marginBasisLabel,
    costLineage: leg.costLineage,
    why: leg.why,
    whyDetail: leg.whyDetail,
    stateDiff: stateDiff(e.action_kind, e.pre_state, e.post_state),
  };
}

const INTEGRATION_ORDER = [
  "shopify",
  "meta_ads",
  "google_ads",
  "tiktok_ads",
  "quickbooks",
  "easypost_ship",
  "shippo_ship",
  "shipbob_ship",
  "shiphero_ship",
] as const;

export function adaptIntegrations(
  record: Record<string, Integration>,
): IntegrationVM[] {
  const keys = Object.keys(record);
  const ordered = [
    ...INTEGRATION_ORDER.filter((k) => k in record),
    ...keys.filter((k) => !(INTEGRATION_ORDER as readonly string[]).includes(k)).sort(),
  ];
  return ordered.map((key) => {
    const i = record[key];
    return {
      key,
      name: i.name,
      status: i.status,
      detail: i.detail,
      logoCls: i.logoCls,
    };
  });
}

// --- typed fetchers (return view-models) -----------------------------------

interface OverviewEnvelope {
  roas_series: DailyRoasRow[];
  campaign_count: number;
  active_campaign_count: number;
  open_alert_count: number;
  open_alert_dollar_impact_cents: number;
}

export async function fetchOverview(): Promise<OverviewVM> {
  const data = await apiGet<OverviewEnvelope>("/dashboard/api/overview");
  return {
    roas_series: adaptDaily(data.roas_series),
    campaign_count: data.campaign_count,
    active_campaign_count: data.active_campaign_count,
    open_alert_count: data.open_alert_count,
    open_alert_dollar_impact_cents: data.open_alert_dollar_impact_cents,
  };
}

interface AlertFilters {
  status?: string;
  severity?: string;
  detector?: string;
}

export async function fetchAlerts(
  filters?: AlertFilters,
  campaigns: CampaignVM[] = [],
): Promise<AlertVM[]> {
  const qs = new URLSearchParams();
  if (filters?.status) qs.set("status", filters.status);
  if (filters?.severity) qs.set("severity", filters.severity);
  if (filters?.detector) qs.set("detector", filters.detector);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  const data = await apiGet<{ alerts: Alert[] }>(`/dashboard/api/alerts${suffix}`);
  return data.alerts.map((a) => adaptAlert(a, campaigns));
}

export async function fetchAlert(
  id: string,
  campaigns: CampaignVM[] = [],
): Promise<AlertVM> {
  const data = await apiGet<{ alert: Alert }>(
    `/dashboard/api/alerts/${encodeURIComponent(id)}`,
  );
  return adaptAlert(data.alert, campaigns);
}

export async function fetchCampaigns(
  grades: CampaignGradeRow[] = [],
): Promise<CampaignVM[]> {
  const data = await apiGet<{ campaigns: Campaign[] }>("/dashboard/api/campaigns");
  return data.campaigns.map((c) => adaptCampaign(c, grades));
}

export async function fetchCampaign(
  id: string,
  grades: CampaignGradeRow[] = [],
): Promise<CampaignVM> {
  const data = await apiGet<{ campaign: Campaign }>(
    `/dashboard/api/campaigns/${encodeURIComponent(id)}`,
  );
  return adaptCampaign(data.campaign, grades);
}

// Mirror of CampaignDirection in ~/lib/actions/direction-reason.server.ts — a
// browser-safe copy (.server modules can't be imported into client bundles).
// Keep these fields in sync by hand when the server type changes.
export interface CampaignDirectionDTO {
  direction: "scale_up" | "scale_down" | "keep" | "pause";
  actionKind: "pause_campaign" | "reduce_campaign_budget" | "increase_campaign_budget" | null;
  suggestedBudgetCents: number | null;
  reason: string;
  reasonSource: "claude" | "template";
  dataSufficient: boolean;
}

export async function fetchCampaignDirection(id: string): Promise<CampaignDirectionDTO> {
  return apiGet<CampaignDirectionDTO>(`/dashboard/api/campaigns/${encodeURIComponent(id)}/direction`);
}

/** Per-campaign daily spend+revenue series for the detail chart (default 90d window). */
export async function fetchCampaignSeries(id: string, days = 90): Promise<DailyRoasRow[]> {
  const data = await apiGet<{ series: DailyRoasRow[] }>(
    `/dashboard/api/campaigns/${encodeURIComponent(id)}/series?days=${days}`,
  );
  return data.series;
}

/** Top "frequently bought with" SKUs for one SKU (trailing 90 days). */
export async function fetchSkuAffinity(id: string): Promise<SkuAffinityItem[]> {
  const data = await apiGet<{ affinity: SkuAffinityItem[] }>(
    `/dashboard/api/skus/${encodeURIComponent(id)}/affinity`,
  );
  return data.affinity;
}

export async function fetchAudit(): Promise<AuditVM[]> {
  const data = await apiGet<{ audit: AuditEntry[] }>("/dashboard/api/audit");
  return data.audit.map(adaptAudit);
}

export async function fetchGuardrails(): Promise<GuardrailVM> {
  const data = await apiGet<{ guardrails: GuardrailConfig }>("/dashboard/api/guardrails");
  return toGuardrailVM(data.guardrails);
}

export async function putGuardrails(
  patch: Partial<GuardrailConfig>,
): Promise<GuardrailVM> {
  const data = await apiSend<{ guardrails: GuardrailConfig }>(
    "PUT",
    "/dashboard/api/guardrails",
    patch,
  );
  return toGuardrailVM(data.guardrails);
}

function toGuardrailVM(g: GuardrailConfig): GuardrailVM {
  return {
    ...g,
    // TODO(api): autopilot_actions_today not yet returned by GuardrailConfig.
    autopilot_actions_today: (g as { autopilot_actions_today?: number })
      .autopilot_actions_today ?? 0,
  };
}

// Mirror of AutopilotDecision / AutopilotSummary in
// ~/lib/actions/autopilot.server.ts — a browser-safe copy (.server modules
// can't be imported into client bundles). The dashboard only needs the landed
// `decisions` (to banner each execution) and the counters; extra server fields
// (blockedReasons) are ignored. Keep in sync by hand when the server type changes.
export interface AutopilotDecisionDTO {
  alertId: string;
  campaignId: string;
  detectorId: string;
  intendedKind: string | null;
  outcome: "acted" | "blocked" | "skipped" | "failed";
  reason: string;
}

export interface AutopilotRunDTO {
  skipped: boolean;
  acted: number;
  blocked: number;
  failed: number;
  considered: number;
  decisions: AutopilotDecisionDTO[];
}

/** Trigger an immediate autopilot run for the session's shop. The dashboard
 * fires this on load when autopilot is enabled; it is idempotent server-side. */
export async function runAutopilot(): Promise<AutopilotRunDTO> {
  return apiSend<AutopilotRunDTO>("POST", "/dashboard/api/autopilot");
}

export interface DemoResetSummary {
  wiped: string[];
  inserted: Record<string, number>;
  promoted: Record<string, unknown>;
}

/** Wipe a DEMO shop back to its seeded opening scene (409 on real shops). */
export async function resetDemoData(): Promise<DemoResetSummary> {
  const data = await apiSend<{ ok: boolean; summary: DemoResetSummary }>(
    "POST",
    "/dashboard/api/demo-reset",
  );
  return data.summary;
}

/** Permanently delete the signed-in first-party account (and its store when the
 * user is its sole member). Irreversible; the caller collects a typed "DELETE"
 * confirmation, which the server re-validates. On success the session cookie is
 * cleared server-side — the caller should hard-navigate to a signed-out page. */
export async function deleteAccount(): Promise<void> {
  await apiSend<{ ok: boolean }>("POST", "/dashboard/api/account", {
    intent: "delete",
    confirm: "DELETE",
  });
}

export async function fetchConsent(): Promise<boolean> {
  const data = await apiGet<{ consent: boolean }>("/dashboard/api/consent");
  return Boolean(data.consent);
}

export async function putConsent(consent: boolean): Promise<boolean> {
  const data = await apiSend<{ consent: boolean }>("PUT", "/dashboard/api/consent", { consent });
  return Boolean(data.consent);
}

export interface ShipCostSettings {
  ship_mode: string;
  missing_weight_pct: number;
}

export async function fetchShipCost(): Promise<ShipCostSettings> {
  return apiGet<ShipCostSettings>("/dashboard/api/ship-cost");
}

/** Set the shop-level ship-cost resolution mode. Detailed inputs (period total,
 * invoice CSV, per-order override) live in the embedded Shopify admin. */
export async function setShipCostMode(mode: string): Promise<void> {
  await apiSend<{ ship_mode: string }>("POST", "/dashboard/api/ship-cost", {
    intent: "set_mode",
    ship_cost_mode: mode,
  });
}

export interface UnmatchedShipChargeVM {
  id: string;
  provider: string | null;
  orderRef: string | null;
  trackingNo: string | null;
  costCents: number;
  externalChargeId: string | null;
  reason: string;
}

export interface UnmatchedShipCharges {
  count: number;
  items: UnmatchedShipChargeVM[];
}

/** Read the shop's unmatched carrier charges (Phase 3 Part C), READ-ONLY on the dashboard
 * — mapping a charge to an order is embedded-admin-only (same split as integrations). */
export async function fetchUnmatchedShipCharges(): Promise<UnmatchedShipCharges> {
  return apiGet<UnmatchedShipCharges>("/dashboard/api/unmatched-ship");
}

// --- payouts (Stripe Connect, #11) -------------------------------------------
// Browser-safe mirror of BillingDTO in ~/lib/payments/connect.server.ts (.server
// modules can't be imported into client bundles). Keep in sync by hand when the
// server type changes.

export interface BillingStatus {
  connected: boolean;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  feeBps: number;
  feeFlatCents: number;
  balance: {
    available: Array<{ amountCents: number; currency: string }>;
    pending: Array<{ amountCents: number; currency: string }>;
  } | null;
}

export async function fetchBilling(): Promise<BillingStatus> {
  return apiGet<BillingStatus>("/dashboard/api/billing");
}

/** Create-or-reuse the shop's Express account and mint a hosted-onboarding link. */
export async function startPayoutOnboarding(): Promise<{ url: string }> {
  return apiSend<{ url: string }>("POST", "/dashboard/api/billing", { intent: "start-onboarding" });
}

/** Pull account status from Stripe (charges/payouts/details flags) and return a fresh DTO. */
export async function refreshPayoutStatus(): Promise<BillingStatus> {
  return apiSend<BillingStatus>("POST", "/dashboard/api/billing", { intent: "refresh-status" });
}

/** Mint a single-use Express-dashboard login link on demand (409 when not onboarded). */
export async function fetchPayoutLoginLink(): Promise<{ url: string }> {
  return apiSend<{ url: string }>("POST", "/dashboard/api/billing", { intent: "login-link" });
}

/** Originate a 50c go-live test transaction and return the Stripe Checkout url. */
export async function startTestTransaction(): Promise<{ url: string }> {
  return apiSend<{ url: string }>("POST", "/dashboard/api/cutover-test-transaction");
}

export async function fetchIntegrations(): Promise<IntegrationVM[]> {
  const data = await apiGet<{ integrations: Record<string, Integration> }>(
    "/dashboard/api/integrations",
  );
  return adaptIntegrations(data.integrations);
}

/**
 * Start a dashboard-native OAuth connect. Returns the provider consent-screen
 * URL to navigate to; the callback lands back on /dashboard?<provider>=connected.
 */
export async function startIntegrationConnect(provider: string): Promise<{ url: string }> {
  return apiSend<{ url: string }>("POST", "/dashboard/api/integrations", {
    intent: "connect",
    provider,
  });
}

/** POST an integrations mutation; the route responds with the refreshed rows. */
async function mutateIntegrations(body: Record<string, unknown>): Promise<IntegrationVM[]> {
  const data = await apiSend<{ integrations: Record<string, Integration> }>(
    "POST",
    "/dashboard/api/integrations",
    body,
  );
  return adaptIntegrations(data.integrations);
}

/** Connect an API-key provider (EasyPost/ShipBob/ShipHero) from a pasted credential. */
export async function connectIntegrationKey(
  provider: string,
  apiKey: string,
): Promise<IntegrationVM[]> {
  return mutateIntegrations({ intent: "connect-key", provider, apiKey });
}

/** Disconnect a provider; returns the refreshed integrations list. */
export async function disconnectIntegration(provider: string): Promise<IntegrationVM[]> {
  return mutateIntegrations({ intent: "disconnect", provider });
}

interface AnalyticsEnvelope {
  roas_series: DailyRoasRow[];
  grades: CampaignGradeRow[];
  top_ads: TopAdRow[];
  meta_can_push_drafts?: boolean;
}

export async function fetchAnalytics(): Promise<{
  daily: DailyRow[];
  grades: CampaignGradeRow[];
  topAds: TopAd[];
  metaCanPushDrafts: boolean;
}> {
  const data = await apiGet<AnalyticsEnvelope>("/dashboard/api/analytics");
  return {
    daily: adaptDaily(data.roas_series),
    grades: data.grades,
    topAds: data.top_ads.map((t) => ({
      ad_name: t.ad_name,
      campaign_name: t.campaign_name,
      reactions: t.reactions,
      comments: t.comments,
      shares: t.shares,
      saves: t.saves,
      engagement: t.engagement,
    })),
    metaCanPushDrafts: data.meta_can_push_drafts ?? false,
  };
}

// --- mutations -------------------------------------------------------------

interface CampaignActionInput {
  type: string;
  dailyBudgetCents?: number;
  alertId?: string;
  /** Required for exclude_geo: the region bucket to drop from the campaign. */
  region?: RegionCode;
}

export async function executeCampaignAction(
  campaignId: string,
  input: CampaignActionInput,
): Promise<{ auditId: string; outcome: string; calibration?: ApproveReceipt }> {
  const body: Record<string, unknown> = {
    type: input.type,
    idempotency_key: crypto.randomUUID(),
  };
  if (input.dailyBudgetCents !== undefined) body.daily_budget_cents = input.dailyBudgetCents;
  if (input.alertId !== undefined) body.alert_id = input.alertId;
  if (input.region !== undefined) body.region = input.region;

  const data = await apiSend<{ audit_id: string; outcome: string; calibration?: ApproveReceipt }>(
    "POST",
    `/dashboard/api/campaigns/${encodeURIComponent(campaignId)}/action`,
    body,
  );
  // Note: 502 action_failed is surfaced as a DashboardApiError by apiSend, with
  // its auditId carried through from the response body.
  return { auditId: data.audit_id, outcome: data.outcome, calibration: data.calibration };
}

/** Push a regenerated winning variant to Meta as a PAUSED draft ad. The
 *  idempotency key is derived server-side from (campaign + variant), so this
 *  sends only the campaign + creative. A 502 surfaces as a DashboardApiError. */
export async function pushCreativeDraft(
  campaignId: string,
  variant: CreativeInput,
): Promise<{ auditId: string; outcome: string }> {
  const data = await apiSend<{ audit_id: string; outcome: string }>(
    "POST",
    `/dashboard/api/campaigns/${encodeURIComponent(campaignId)}/action`,
    {
      type: "push_creative_draft",
      creative: {
        headline: variant.headline,
        primaryText: variant.primaryText,
        cta: variant.cta,
        destinationUrl: variant.destinationUrl,
        imageUrl: variant.imageUrl,
        audience: variant.audience,
      },
    },
  );
  return { auditId: data.audit_id, outcome: data.outcome };
}

export async function executeAlertAction(
  alertId: string,
  input: { type: string; newPriceCents?: number; poQuantity?: string; poUnitCost?: string },
): Promise<{ auditId: string; outcome: string; acknowledged: boolean; calibration?: ApproveReceipt }> {
  const body: Record<string, unknown> = { type: input.type, idempotency_key: crypto.randomUUID() };
  // adjust_price only: optional merchant override; omitted → engine suggestion.
  if (input.newPriceCents !== undefined) body.new_price_cents = input.newPriceCents;
  // create_po_draft only: quantity + optional unit cost (blank → TBD).
  if (input.poQuantity !== undefined) body.po_quantity = input.poQuantity;
  if (input.poUnitCost !== undefined) body.po_unit_cost = input.poUnitCost;
  const data = await apiSend<{
    audit_id: string;
    outcome: string;
    acknowledged: boolean;
    calibration?: ApproveReceipt;
  }>("POST", `/dashboard/api/alerts/${encodeURIComponent(alertId)}/action`, body);
  return {
    auditId: data.audit_id,
    outcome: data.outcome,
    acknowledged: data.acknowledged,
    calibration: data.calibration,
  };
}

export async function relocateSku(
  skuId: string,
  input: {
    fromLocationId: string;
    toLocationId: string;
    quantity: number;
    /**
     * Owned by the caller (one key per relocation intent, minted when the
     * dialog opens) so a retry after a timeout dedupes against a possibly
     * applied transfer instead of executing it twice.
     */
    idempotencyKey: string;
  },
): Promise<{ auditId: string; outcome: string }> {
  const data = await apiSend<{ audit_id: string; outcome: string }>(
    "POST",
    `/dashboard/api/skus/${encodeURIComponent(skuId)}/relocate`,
    {
      from_location_id: input.fromLocationId,
      to_location_id: input.toLocationId,
      quantity: input.quantity,
      idempotency_key: input.idempotencyKey,
    },
  );
  return { auditId: data.audit_id, outcome: data.outcome };
}

export async function undoAudit(auditId: string): Promise<{ auditId: string }> {
  const data = await apiSend<{ audit_id: string }>(
    "POST",
    `/dashboard/api/audit/${encodeURIComponent(auditId)}/undo`,
  );
  return { auditId: data.audit_id };
}

export type { LiveAnalyticsSnapshot };

export async function fetchLiveAnalytics(): Promise<LiveAnalyticsSnapshot> {
  return apiGet<LiveAnalyticsSnapshot>("/dashboard/api/analytics-live");
}

export async function getRealtimeToken(): Promise<{
  token: string;
  url: string;
  publishableKey: string;
  shopId: string;
  expiresAt: string;
} | null> {
  try {
    const data = await apiGet<{
      token: string;
      url: string;
      publishable_key: string;
      shop_id: string;
      expires_at: string;
    }>("/dashboard/api/realtime-token");
    return {
      token: data.token,
      url: data.url,
      publishableKey: data.publishable_key,
      shopId: data.shop_id,
      expiresAt: data.expires_at,
    };
  } catch (err) {
    if (err instanceof DashboardApiError && err.status === 503) return null;
    throw err;
  }
}

export async function logout(): Promise<void> {
  await apiSend<{ ok: true }>("POST", "/dashboard/api/logout");
}

// --- assistant ---------------------------------------------------------------

export interface AssistantHistory {
  conversations: AssistantConversation[];
  conversationId: string | null;
  messages: AssistantMessage[];
}

export async function fetchAssistantHistory(): Promise<AssistantHistory> {
  const data = await apiGet<{
    conversations: AssistantConversation[];
    conversation_id: string | null;
    messages: AssistantMessage[];
  }>("/dashboard/api/assistant");
  return {
    conversations: data.conversations,
    conversationId: data.conversation_id,
    messages: data.messages,
  };
}

/**
 * Send failure that still carries the server-side conversation id — the user
 * turn may already be persisted, so retries should stay in the same thread.
 */
export class AssistantSendError extends Error {
  readonly conversationId: string | null;

  constructor(message: string, conversationId: string | null) {
    super(message);
    this.name = "AssistantSendError";
    this.conversationId = conversationId;
  }
}

export async function sendAssistantMessage(
  message: string,
  conversationId: string | null,
): Promise<{ conversationId: string; message: AssistantMessage }> {
  // Raw fetch (not apiSend): the 502 error body carries conversation_id and
  // its `message` field is a string, not the AssistantMessage of the 200 body.
  const res = await fetch("/dashboard/api/assistant", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", Origin: location.origin },
    body: JSON.stringify({ message, conversation_id: conversationId ?? undefined }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    conversation_id?: string;
    message?: AssistantMessage | string;
    error?: string;
  };
  if (res.status === 401) redirectToLogin();
  if (!res.ok) {
    const msg =
      typeof body.message === "string" ? body.message : body.error ?? "Could not reach Calderyn";
    throw new AssistantSendError(msg, body.conversation_id ?? null);
  }
  return {
    conversationId: String(body.conversation_id),
    message: body.message as AssistantMessage,
  };
}

/** Confirm a Tier-2 pending action by id — the server re-resolves the action
 *  and its parameters from the pending row, so this call carries no payload
 *  the client could tamper with. Errors (expired/already-used/not-found)
 *  surface as a DashboardApiError with code "pending_unavailable". The
 *  `message` is the persisted follow-up turn the server appends to the thread
 *  (best-effort — null when that bookkeeping step failed even though the
 *  action itself already ran), so the caller can show real history instead of
 *  fabricating a local line. */
export async function confirmAssistantAction(
  pendingId: string,
): Promise<{ receipt: ActionReceipt; message: AssistantMessage | null }> {
  const data = await apiSend<{ receipt: ActionReceipt; message: AssistantMessage | null }>(
    "POST",
    "/dashboard/api/assistant/confirm",
    { pending_id: pendingId, decision: "confirm" },
  );
  return { receipt: data.receipt, message: data.message ?? null };
}

/** Dismiss a Tier-2 pending action by id without running it. Returns the
 *  server's `dismissed` flag: `false` means the pending row was NOT actually
 *  pending (already executed/dismissed elsewhere, or expired) — the caller
 *  must not report this as a plain "no changes made" dismissal. */
export async function dismissAssistantAction(pendingId: string): Promise<boolean> {
  const data = await apiSend<{ dismissed: boolean }>("POST", "/dashboard/api/assistant/confirm", {
    pending_id: pendingId,
    decision: "dismiss",
  });
  return data.dismissed;
}

// --- calibration -------------------------------------------------------------

export async function fetchCalibration(): Promise<{
  pct: number | null;
  updated_at: string | null;
  nearGraduation: number;
}> {
  const data = await apiGet<{ pct: number | null; updated_at: string | null; nearGraduation?: number }>(
    "/dashboard/api/calibration",
  );
  return { pct: data.pct, updated_at: data.updated_at, nearGraduation: data.nearGraduation ?? 0 };
}

export async function fetchActionQueue(): Promise<QueueProposalVM[]> {
  const data = await apiGet<{ proposals: QueueProposalVM[] }>("/dashboard/api/queue");
  return data.proposals;
}

export interface RejectResult {
  reflection: string;
  delta: number;
  before: number;
  after: number;
  savedAsRule: boolean;
}

/** Reject a proposal for an alert with a plain-language reason.
 *  Re-derives detector/action server-side from the trusted alert.
 *  NEVER executes any action. Returns the reject receipt (reflection + trust delta).
 *  Muting a shipped no-brainer (reason i_handle_this) 409s with code
 *  "confirm_required" until re-sent with confirmed=true — the I8 interstitial. */
export async function rejectProposal(input: {
  alertId: string;
  reason: RejectReason;
  note?: string;
  confirmed?: boolean;
}): Promise<RejectResult> {
  return apiSend<RejectResult>("POST", "/dashboard/api/queue/reject", input);
}

/** Return all active learned calibration rules for the session's shop. */
export async function fetchLearnedRules(): Promise<LearnedRuleVM[]> {
  const data = await apiGet<{ rules: LearnedRule[] }>("/dashboard/api/calibration/rules");
  // LearnedRule and LearnedRuleVM have the same shape; cast through directly.
  return data.rules as LearnedRuleVM[];
}

/** Deactivate (undo) a learned calibration rule by id. */
export async function undoRule(ruleId: string): Promise<void> {
  await apiSend<{ ok: true }>("POST", "/dashboard/api/calibration/rules", { ruleId });
}

// --- live engine -------------------------------------------------------------

/** Fetch the full Live Engine page bundle (autopilot features + money, engine
 *  pipeline, live trace, predictions, calibration headline). */
export async function fetchLiveEngine(): Promise<LiveEnginePageData> {
  return apiGet<LiveEnginePageData>("/dashboard/api/live-engine");
}

/** Turn a graduated feature's unattended autonomy on/off. The shop is taken from
 *  the session server-side; the UPDATE is scoped by shop + detector + action, so
 *  an unknown (detector, action) pair simply matches no row and is a no-op. */
export async function toggleFeatureAutonomy(input: {
  detectorId: string;
  actionKind: string;
  enabled: boolean;
}): Promise<{ ok: boolean; enabled: boolean }> {
  return apiSend<{ ok: boolean; enabled: boolean }>("POST", "/dashboard/api/live-engine/toggle", input);
}

// --- creative screener (campaign drop-in) ------------------------------------

export interface ScreenCreativePayload {
  headline: string;
  primaryText: string;
  cta: string;
  destinationUrl: string;
  audience: string;
  assumedSpendCents: number;
  mediaKind: "image" | "video";
  imageUrl: string;
  videoFrameUrls?: string[];
  videoDurationSec?: number;
}

// --- campaign creatives + per-campaign regenerate / screen ------------------
// Browser-safe DTO mirrors of the server-side AdScorecard / CampaignCreative
// shapes. client.ts must not import any *.server module (top-of-file contract),
// so the wire shapes are re-declared here from the browser-safe screener/types.

export interface AdScorecardDTO {
  adId: string;
  status: "done" | "error";
  scorecard: ScoreCard | null;
  error: string | null;
}

export interface CampaignCreativeDTO {
  adId: string;
  adName: string;
  status: string;
  creative: CreativeInput;
}

export interface CampaignCreativesDTO {
  creatives: CampaignCreativeDTO[];
  scorecards: AdScorecardDTO[];
  assumedSpendCents: number;
  metaConnected: boolean;
  creativesError: string | null;
}

export async function fetchCampaignCreatives(
  campaignId: string,
  assumedSpendCents?: number,
): Promise<CampaignCreativesDTO> {
  const q = assumedSpendCents ? `?assumedSpendCents=${assumedSpendCents}` : "";
  return apiGet<CampaignCreativesDTO>(
    `/dashboard/api/campaigns/${encodeURIComponent(campaignId)}/creatives${q}`,
  );
}

export async function scoreCampaignAd(
  campaignId: string,
  payload: {
    adId: string;
    headline: string;
    primaryText: string;
    cta: string;
    destinationUrl: string;
    audience: string;
    imageUrl: string | null;
    assumedSpendCents: number;
  },
): Promise<AdScorecardDTO> {
  const data = await apiSend<{ scorecard: AdScorecardDTO }>(
    "POST",
    `/dashboard/api/campaigns/${encodeURIComponent(campaignId)}/score`,
    payload,
  );
  return data.scorecard;
}

export type RegenerateDTO =
  | { ok: true; runId: string; weakestAdId: string; variants: Variant[]; allScored: Variant[]; generated: number; discarded: number }
  | { ok: false; reason: string };

export async function regenerateCampaign(
  campaignId: string,
  adIds: string[],
  assumedSpendCents: number,
): Promise<RegenerateDTO> {
  return apiSend<RegenerateDTO>(
    "POST",
    `/dashboard/api/campaigns/${encodeURIComponent(campaignId)}/regenerate`,
    { adIds, assumedSpendCents },
  );
}

export async function screenCampaignCreative(
  campaignId: string,
  payload: ScreenCreativePayload,
): Promise<CreativeScreenRun> {
  const data = await apiSend<{ run: CreativeScreenRun }>(
    "POST",
    `/dashboard/api/campaigns/${encodeURIComponent(campaignId)}/screen`,
    payload,
  );
  return data.run;
}

// --- catalog (Slice 1, owned) ------------------------------------------------
// Browser view-models for the owned catalog editor. The outbound `ProductDraft`
// mirrors the server `ProductInput` (app/lib/catalog/types.ts) — variants carry
// option-value LABELS (e.g. ["M","Red"]), which the write path resolves to ids.
// The inbound detail VM is already label-shaped + signed by the $id loader.

export interface ProductSummaryVM {
  id: string;
  title: string;
  status: "draft" | "active" | "archived";
  imageUrl: string | null;
  variantCount: number;
  updatedAt: string;
  /** Lowest variant price in cents; null when no variant carries a price. */
  priceCents: number | null;
  /** True when every variant passes the activation shipping check (the same
   * predicate behind the `incomplete_shipping` 422). */
  shipDataOk: boolean;
  /** Heaviest physical-variant weight in grams; null when none recorded. */
  shipWeightGrams: number | null;
}

export interface VariantDraft {
  id?: string;
  sku?: string;
  title?: string;
  retailPriceCents?: number;
  compareAtPriceCents?: number;
  unitCostCents?: number;
  inventoryTracked?: boolean;
  inventoryOnHand?: number;
  /** Option-value labels this variant represents, in option order. */
  optionValues?: string[];
  // Shipping fields — all optional so incomplete products remain saveable as drafts.
  weightGrams?: number;
  lengthMm?: number;
  widthMm?: number;
  heightMm?: number;
  requiresShipping?: boolean;
  handlingDays?: number;
  signatureRequired?: boolean;
  restrictedCountries?: string[];
}

export interface ProductDraft {
  title: string;
  status: "draft" | "active" | "archived";
  /** URL handle — include only when the merchant edited it (the server keeps
   *  the stored one otherwise and generates one on create). */
  handle?: string;
  vendor?: string;
  category?: string;
  description?: string;
  tags?: string[];
  options?: Array<{ name: string; values: string[] }>;
  variants: VariantDraft[];
  collectionIds?: string[];
  /** Search-listing override; both fields empty clears the stored override. */
  seo?: { metaTitle?: string; metaDescription?: string };
}

export type { SeoListingVM } from "~/lib/catalog/types";

export interface ProductDetailVM extends ProductDraft {
  id: string;
  handle: string;
  media: Array<{ id: string; url: string; isPrimary: boolean; alt: string | null; position: number }>;
  updatedAt: string;
  /** Null when the search-listing reads failed server-side — the editor shows
   *  the card as temporarily unavailable and must not submit `seo`. */
  seoListing: SeoListingVM | null;
}

export interface CollectionVM {
  id: string;
  title: string;
  handle: string;
  /** Number of products in the collection (server-folded membership count). */
  productCount: number;
}

/** One collection member row for the detail view — thumbnail pre-signed. */
export interface CollectionProductVM {
  id: string;
  title: string;
  status: "draft" | "active" | "archived";
  imageUrl: string | null;
}

export async function fetchProducts(
  opts: { search?: string; status?: string; offset?: number; sort?: CatalogSort } = {},
): Promise<{ products: ProductSummaryVM[]; total: number }> {
  const qs = new URLSearchParams();
  if (opts.search) qs.set("search", opts.search);
  if (opts.status) qs.set("status", opts.status);
  if (opts.offset) qs.set("offset", String(opts.offset));
  if (opts.sort && opts.sort !== "updated") qs.set("sort", opts.sort);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return apiGet<{ products: ProductSummaryVM[]; total: number }>(
    `/dashboard/api/catalog/products${suffix}`,
  );
}

export async function fetchProduct(id: string): Promise<ProductDetailVM> {
  const data = await apiGet<{ product: ProductDetailVM }>(
    `/dashboard/api/catalog/products/${encodeURIComponent(id)}`,
  );
  return data.product;
}

/** POST to create (no id) or PUT to update (id). Returns the product id either
 *  way — the PUT route replies `{ ok: true }`, so the caller's id is echoed. */
export async function saveProduct(draft: ProductDraft, id?: string): Promise<{ id: string }> {
  if (id) {
    await apiSend("PUT", `/dashboard/api/catalog/products/${encodeURIComponent(id)}`, draft);
    return { id };
  }
  return apiSend<{ id: string }>("POST", "/dashboard/api/catalog/products", draft);
}

/** Archive (soft-delete) a product — the DELETE route flips status to archived. */
export async function archiveProduct(id: string): Promise<void> {
  await apiSend("DELETE", `/dashboard/api/catalog/products/${encodeURIComponent(id)}`);
}

// --- bulk catalog actions ------------------------------------------------------

/** One product's outcome from a bulk catalog action: ok, or ok:false + a plain-language
 *  error — never thrown per-product, since partial failure across a bulk selection is
 *  normal, expected output. */
export interface BulkProductResultVM {
  productId: string;
  ok: boolean;
  error?: string;
}

interface BulkProductResultWire {
  product_id: string;
  ok: boolean;
  error?: string;
}

function mapBulkProductResults(rows: BulkProductResultWire[]): BulkProductResultVM[] {
  return rows.map((r) => ({ productId: r.product_id, ok: r.ok, error: r.error }));
}

// The catalog page size is 50 (listProducts' default limit), so "select all on this page" can
// hand these functions up to 50 ids — but the server-side bulk routes cap a single request at
// MAX_BULK_PRODUCTS = 25 (app/lib/catalog/bulk.server.ts) and 422 the WHOLE request over that.
// runBulkInChunks (shared with the orders bulk client, same 25-id server cap) slices the
// selection, sends the slices sequentially, and downgrades a whole-slice rejection to
// per-product failures so already-applied results are never discarded.

/** How a product lands in the flat results when its whole chunk rejected. */
const productFailure = (productId: string, error: string): BulkProductResultVM => ({
  productId,
  ok: false,
  error,
});

/** Set every selected product's status. No idempotency key — a status write is naturally
 *  idempotent, so a retried request converges on the same state. */
export async function bulkSetProductStatus(
  productIds: string[],
  status: "active" | "draft" | "archived",
): Promise<{ results: BulkProductResultVM[] }> {
  return runBulkInChunks(productIds, async (slice) => {
    const data = await apiSend<{ results: BulkProductResultWire[] }>(
      "POST",
      "/dashboard/api/catalog/products/bulk/status",
      { product_ids: slice, status },
    );
    return { results: mapBulkProductResults(data.results) };
  }, productFailure);
}

/** Add every selected product to a collection. Membership writes are naturally idempotent
 *  (the server upsert ignores duplicates), so no idempotency key here either. */
export async function bulkAddProductsToCollection(
  productIds: string[],
  collectionId: string,
): Promise<{ results: BulkProductResultVM[] }> {
  return runBulkInChunks(productIds, async (slice) => {
    const data = await apiSend<{ results: BulkProductResultWire[] }>(
      "POST",
      "/dashboard/api/catalog/products/bulk/collection",
      { product_ids: slice, collection_id: collectionId },
    );
    return { results: mapBulkProductResults(data.results) };
  }, productFailure);
}

export async function fetchCollections(): Promise<CollectionVM[]> {
  const data = await apiGet<{ collections: CollectionVM[] }>("/dashboard/api/catalog/collections");
  return data.collections;
}

export async function createCollection(title: string): Promise<CollectionVM> {
  const data = await apiSend<{ id: string }>("POST", "/dashboard/api/catalog/collections", { title });
  // Optimistic handle via the SAME shared helper the server uses, so the row
  // labels itself with the authoritative slug immediately (no drift). A brand
  // new collection has no members yet, so the count is authoritatively zero.
  return { id: data.id, title, handle: collectionHandle(title), productCount: 0 };
}

/** Rename a collection. The handle is deliberately left unchanged server-side
 *  so existing storefront links keep resolving. */
export async function renameCollection(id: string, title: string): Promise<void> {
  await apiSend("PUT", `/dashboard/api/catalog/collections/${encodeURIComponent(id)}`, { title });
}

/** Delete a collection (memberships included). Products are untouched. */
export async function deleteCollection(id: string): Promise<void> {
  await apiSend("DELETE", `/dashboard/api/catalog/collections/${encodeURIComponent(id)}`);
}

export async function fetchCollectionProducts(id: string): Promise<CollectionProductVM[]> {
  const data = await apiGet<{ products: CollectionProductVM[] }>(
    `/dashboard/api/catalog/collections/${encodeURIComponent(id)}/products`,
  );
  return data.products;
}

export async function addToCollection(id: string, productId: string): Promise<void> {
  await apiSend("POST", `/dashboard/api/catalog/collections/${encodeURIComponent(id)}/products`, { productId });
}

export async function removeFromCollection(id: string, productId: string): Promise<void> {
  await apiSend("DELETE", `/dashboard/api/catalog/collections/${encodeURIComponent(id)}/products`, { productId });
}

/** Upload one product image. Multipart, so this uses a raw fetch (apiSend forces
 *  JSON): the browser sets the multipart boundary; do NOT set Content-Type. The
 *  server signs the stored path and returns a ready-to-render URL. */
export async function uploadProductImage(productId: string, file: File): Promise<{ id: string; url: string }> {
  const fd = new FormData();
  fd.set("productId", productId);
  fd.set("file", file);
  const res = await fetch("/dashboard/api/catalog/media", {
    method: "POST",
    credentials: "same-origin",
    headers: { Origin: location.origin },
    body: fd,
  });
  if (res.status === 401) redirectToLogin();
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as { id: string; url: string };
}

export async function deleteProductImage(mediaId: string): Promise<void> {
  await apiSend("DELETE", "/dashboard/api/catalog/media", { mediaId });
}

/** Make this image the product's main (storefront lead) image. */
export async function setPrimaryProductImage(mediaId: string): Promise<void> {
  await apiSend("PUT", "/dashboard/api/catalog/media", { mediaId, intent: "set_primary" });
}

/** Set an image's alt text; empty clears it. */
export async function setProductImageAlt(mediaId: string, alt: string | null): Promise<void> {
  await apiSend("PUT", "/dashboard/api/catalog/media", { mediaId, intent: "set_alt", alt });
}

/** Move an image one step in the gallery order; past-the-edge moves no-op. */
export async function moveProductImage(mediaId: string, dir: "up" | "down"): Promise<void> {
  await apiSend("PUT", "/dashboard/api/catalog/media", { mediaId, intent: "move", dir });
}

// --- AI listing drafts (new-product flow) ------------------------------------

// The wire shapes (ops, plan, request context) live in the shared contract
// module so this client and the route can't drift.
export type { ListingDraftCurrent } from "~/lib/catalog/listing-prompt";

/** Prompt → structured listing edits via the Claude-backed endpoint. Only
 *  called for prompts the local deterministic parser can't place (see
 *  app/lib/catalog/listing-prompt.ts); errors are DashboardApiError. */
export async function fetchListingDraft(
  prompt: string,
  current: ListingDraftCurrent,
): Promise<ListingPlan> {
  return apiSend<ListingPlan>("POST", "/dashboard/api/listing-draft", { prompt, current });
}

// --- inventory --------------------------------------------------------------

export interface VariantBalanceVM {
  locationId: string;
  locationName: string;
  onHand: number;
  reserved: number;
  incoming: number;
  available: number;
  reorderPoint: number | null;
}
export interface LocationVM {
  id: string;
  name: string;
  priority: number;
  lat: number | null;
  lng: number | null;
  street1?: string;
  street2?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  country?: string;
}
export interface LedgerEntryVM {
  id: number;
  location_id: string;
  entry_type: string;
  qty: number;
  reason: string | null;
  created_at: string;
}

export async function fetchVariantInventory(variantId: string): Promise<VariantBalanceVM[]> {
  const d = await apiGet<{ balances: VariantBalanceVM[] }>(
    `/dashboard/api/catalog/inventory/${encodeURIComponent(variantId)}`,
  );
  return d.balances;
}
export async function setOnHand(variantId: string, locationId: string, onHand: number): Promise<void> {
  await apiSend("PUT", `/dashboard/api/catalog/inventory/${encodeURIComponent(variantId)}`, {
    intent: "set_on_hand",
    locationId,
    onHand,
  });
}
export async function setVariantReorderPoint(variantId: string, locationId: string, reorderPoint: number | null): Promise<void> {
  await apiSend("PUT", `/dashboard/api/catalog/inventory/${encodeURIComponent(variantId)}`, {
    intent: "set_reorder",
    locationId,
    reorderPoint,
  });
}
export async function markVariantUnavailable(variantId: string, locationId: string, qty: number, reason: string): Promise<void> {
  await apiSend("PUT", `/dashboard/api/catalog/inventory/${encodeURIComponent(variantId)}`, {
    intent: "mark_unavailable",
    locationId,
    qty,
    reason,
  });
}
export async function createTransfer(input: {
  variantId: string;
  fromLocationId: string;
  toLocationId: string;
  qty: number;
  mode: "instant" | "in_transit";
}): Promise<{ transferId: string }> {
  return apiSend<{ transferId: string }>("POST", "/dashboard/api/catalog/inventory/transfer", input);
}
export async function receiveTransfer(transferId: string): Promise<void> {
  await apiSend("POST", "/dashboard/api/catalog/inventory/transfer", { intent: "receive", transferId });
}
export interface PendingTransferVM {
  id: string;
  variantId: string;
  qty: number;
  fromName: string;
  toName: string;
  createdAt: string;
}
export async function fetchPendingTransfers(variantId: string): Promise<PendingTransferVM[]> {
  const d = await apiGet<{ transfers: PendingTransferVM[] }>(
    `/dashboard/api/catalog/inventory/transfer?variantId=${encodeURIComponent(variantId)}`,
  );
  return d.transfers;
}
export async function fetchInventoryHistory(variantId: string): Promise<LedgerEntryVM[]> {
  const d = await apiGet<{ history: LedgerEntryVM[] }>(
    `/dashboard/api/catalog/inventory/${encodeURIComponent(variantId)}/history`,
  );
  return d.history;
}
/** One shop-wide inventory list row: per-variant balance rollups across
 *  locations, plus the latest recent restock-draft audit entry when one
 *  targets this variant's sku (null otherwise). */
export interface InventoryRowVM {
  variantId: string;
  productId: string;
  sku: string | null;
  variantTitle: string | null;
  productTitle: string;
  onHand: number;
  reserved: number;
  incoming: number;
  available: number;
  low: boolean;
  locationCount: number;
  singleLocationId: string | null;
  restock: { auditId: string; createdAt: string; outcome: string } | null;
}
export async function fetchInventoryList(
  opts: { search?: string; stock?: "low" | "out"; offset?: number } = {},
): Promise<{ rows: InventoryRowVM[]; total: number }> {
  const params = new URLSearchParams();
  if (opts.search) params.set("search", opts.search);
  if (opts.stock) params.set("stock", opts.stock);
  if (opts.offset) params.set("offset", String(opts.offset));
  const qs = params.toString();
  return apiGet<{ rows: InventoryRowVM[]; total: number }>(
    `/dashboard/api/catalog/inventory${qs ? `?${qs}` : ""}`,
  );
}
/** One purchase-order draft row: a create_po_draft audit entry with its PO
 *  snapshot summarized. `hasPdf` mirrors the PDF route's 404 predicate, so the
 *  download button only renders when the download can actually succeed. */
export interface PurchaseOrderVM {
  id: string;
  poNumber: string | null;
  sku: string | null;
  lineCount: number;
  totalCents: number | null;
  outcome: string;
  createdAt: string;
  lastError: string | null;
  hasPdf: boolean;
}
export async function fetchPurchaseOrders(
  opts: { offset?: number } = {},
): Promise<{ rows: PurchaseOrderVM[]; total: number }> {
  const qs = opts.offset ? `?offset=${encodeURIComponent(String(opts.offset))}` : "";
  return apiGet<{ rows: PurchaseOrderVM[]; total: number }>(
    `/dashboard/api/catalog/purchase-orders${qs}`,
  );
}
// ----- Import from Shopify (#13.promote) -----
export interface ImportRunVM {
  id: string;
  state: "pulling" | "promoting" | "done" | "error";
  counts: { products: number; variants: number; collections: number; balances: number } | null;
  report: { imported: string[]; notIncluded: string[] } | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

/** The run states that mean "the port is still working" — shared by every
 *  surface that polls it (Store watcher, Import screen) so they can't drift. */
export const IMPORT_IN_PROGRESS: ReadonlySet<ImportRunVM["state"]> = new Set([
  "pulling",
  "promoting",
]);

export async function fetchImportStatus(): Promise<ImportRunVM | null> {
  const d = await apiGet<{ run: ImportRunVM | null }>("/dashboard/api/import");
  return d.run;
}

export async function startShopifyImport(): Promise<{ importId: string }> {
  return apiSend<{ importId: string }>("POST", "/dashboard/api/import");
}

// ----- Cutover / go live (Step 9) -----
export type CutoverMode = "mirror" | "importing" | "dual_run" | "live";

export interface GateCheckVM {
  name: string;
  label: string;
  expected: string;
  actual: string;
  pass: boolean;
}

export interface CutoverStatusVM {
  mode: CutoverMode;
  allowed: CutoverMode[];
  gates: { pass: boolean; paymentCleared: boolean; checks: GateCheckVM[] };
}

export async function fetchCutoverStatus(): Promise<CutoverStatusVM> {
  return apiGet<CutoverStatusVM>("/dashboard/api/cutover");
}

/** Move the shop's cutover mode. A blocked move (failing gate, illegal step) surfaces
 *  as a DashboardApiError whose message names exactly what is still failing. */
export async function requestCutoverTransition(
  to: CutoverMode,
  reason?: string,
): Promise<CutoverStatusVM> {
  return apiSend<CutoverStatusVM>("POST", "/dashboard/api/cutover", { to, reason });
}

export interface DriftRowVM {
  variantId: string;
  label: string;
  locationId?: string;
  /** Cents for price rows, units for stock rows. */
  owned: number;
  shopify: number;
}

export interface DriftReportVM {
  variantsChecked: number;
  pass: boolean;
  price: { count: number; rows: DriftRowVM[] };
  stock: { count: number; rows: DriftRowVM[] };
  shopifyOnly: { count: number; sample: string[] };
  ownedOnly: { count: number; sample: string[] };
  truncated: { count: number; sample: string[] };
  unmatchedLocations: number;
}

/** On-demand dual-run drift check: live Shopify values diffed against Calderyn's own
 *  tables. Shopify being unreachable surfaces as a DashboardApiError with plain copy. */
export async function fetchCutoverDrift(): Promise<DriftReportVM> {
  return apiGet<DriftReportVM>("/dashboard/api/cutover-drift");
}

export async function fetchLocations(): Promise<LocationVM[]> {
  const d = await apiGet<{ locations: LocationVM[] }>("/dashboard/api/catalog/locations");
  return d.locations;
}
/** Active locations plus the deactivated ones, for the reactivation panel. */
export async function fetchLocationsWithInactive(): Promise<{ locations: LocationVM[]; inactive: LocationVM[] }> {
  const d = await apiGet<{ locations: LocationVM[]; inactive?: LocationVM[] }>(
    "/dashboard/api/catalog/locations?includeInactive=1",
  );
  return { locations: d.locations, inactive: d.inactive ?? [] };
}
export async function updateLocation(
  id: string,
  patch: {
    priority?: number;
    lat?: number | null;
    lng?: number | null;
    street1?: string;
    street2?: string;
    city?: string;
    region?: string;
    postalCode?: string;
    country?: string;
  },
): Promise<void> {
  await apiSend("PUT", `/dashboard/api/catalog/locations/${encodeURIComponent(id)}`, patch);
}
export async function createLocation(input: { name: string; priority?: number }): Promise<{ id: string }> {
  return apiSend<{ id: string }>("POST", "/dashboard/api/catalog/locations", input);
}
/** Deactivate a location. Rejects with a 409 DashboardApiError while any stock
 *  (on hand, reserved, or incoming) still sits there. */
export async function deactivateLocation(id: string): Promise<void> {
  await apiSend("PUT", `/dashboard/api/catalog/locations/${encodeURIComponent(id)}`, { active: false });
}
/** Reactivate a deactivated location so it fills orders again. */
export async function reactivateLocation(id: string): Promise<void> {
  await apiSend("PUT", `/dashboard/api/catalog/locations/${encodeURIComponent(id)}`, { active: true });
}
