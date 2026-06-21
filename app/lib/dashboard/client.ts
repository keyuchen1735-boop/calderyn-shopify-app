// app/lib/dashboard/client.ts
//
// Browser-only data layer for the dashboard SPA. Fetches the /dashboard/api/*
// endpoints and adapts the raw API JSON (app/lib/types.ts) into the view-models
// the screens consume (app/components/dashboard/view-models.ts).
//
// This module is client-only: it uses fetch, crypto.randomUUID(), and
// location.origin. It MUST NOT import any *.server.ts module.

import type {
  Alert,
  AuditEntry,
  Campaign,
  CampaignGradeRow,
  DailyRoasRow,
  GuardrailConfig,
  Integration,
  SKU,
  SkuAffinityItem,
  SkuHistoryPoint,
  TopAdRow,
} from "~/lib/types";
import type {
  AlertVM,
  AuditVM,
  CampaignVM,
  DailyRow,
  GuardrailVM,
  IntegrationVM,
  OverviewVM,
  QueueProposalVM,
  Scorecard,
  SkuVM,
  TopAd,
} from "~/components/dashboard/view-models";
import { DETECTOR_TO_ACTIONS } from "~/lib/labels";
import { gradeFromRow } from "~/lib/campaign-grade";
import { friendlyActionError, displayAuditTarget } from "~/lib/friendly-error";
import { projectedStockoutDate } from "~/lib/inventory-demand";
import { auditLegibility } from "~/lib/audit-legibility";
import { stateDiff } from "~/lib/audit-state-diff";
import type { CreativeScreenRun } from "~/lib/screener/types";
import type {
  ChatMessage as AssistantMessage,
  ConversationSummary as AssistantConversation,
} from "~/lib/assistant/types";

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
  location.assign("/dashboard/login");
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
  const campaign_id =
    a.campaign_id ??
    (a.campaign != null ? campaigns.find((c) => c.name === a.campaign)?.id ?? null : null);

  // Only live-executable kinds render as buttons: campaign kinds go through
  // /dashboard/api/campaigns/:id/action, reallocate_inventory through
  // /dashboard/api/alerts/:id/action. Detector kinds without a dashboard
  // endpoint (exclude_geo, create_po_draft) stay hidden until wired.
  const detectorActions = DETECTOR_TO_ACTIONS[a.detector_id] ?? [];
  const actions: string[] = [
    ...(campaign_id ? ["pause_campaign", "reduce_campaign_budget"] : []),
    ...(detectorActions.includes("reallocate_inventory") ? ["reallocate_inventory"] : []),
    "snooze_alert",
  ];

  // recommended is the first concrete action; if all we can do is snooze there
  // is no recommendation to surface.
  const recommended = actions.length > 1 ? actions[0] : null;

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
    campaign_id,
    actions,
    recommended,
    rec_detail: "", // TODO(api): server-provided recommendation
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
  push_ad_draft: "Pushed ad draft",
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

export function adaptSku(s: SKU): SkuVM {
  // Older payloads may carry an empty code; fall back to the title so the row
  // still labels itself. TODO(api): category on SKU.
  const skuCode = s.sku || s.title;
  const category = (s as { category?: string }).category ?? "";

  const total = Object.values(s.locations ?? {}).reduce((sum, n) => sum + n, 0);
  const maxShare = total > 0 ? Math.max(0, ...Object.values(s.locations ?? {})) / total : 0;

  let status: string;
  if (s.on_hand === 0) status = "stockout";
  else if (s.days_of_cover < 10) status = "risk";
  else if (s.days_of_cover < 21) status = "reorder";
  // "Wrong location concentration" only matters when the SKU is actually selling
  // — concentrated stock at ~0 velocity is not at risk, it's just sitting (P2-13).
  else if (total > 0 && maxShare > 0.6 && s.velocity > 0) status = "misplaced";
  else status = "healthy";

  return {
    id: s.id,
    title: s.title,
    sku: skuCode,
    category,
    on_hand: s.on_hand,
    days_of_cover: s.days_of_cover,
    velocity: s.velocity,
    projected_stockout: projectedStockoutDate(s.days_of_cover, s.velocity),
    revenue_30d_cents: s.revenue_30d_cents,
    vendor: s.vendor,
    product_type: s.product_type,
    tags: s.tags,
    collections: s.collections,
    returns: s.returns,
    locations: s.locations,
    status,
    sources: s.sources ?? [],
    demand: s.demand ?? null,
    suggested_transfer: s.suggested_transfer ?? null,
    locations_detail: s.locations_detail ?? [],
    ship_cost_source: s.ship_cost_source ?? null,
    ship_cost_confidence: s.ship_cost_confidence ?? null,
    ship_pnl_cents: s.ship_pnl_cents ?? null,
  };
}

/** Numeric SkuVM metrics the inventory screen can rank by. */
export type SkuSortKey = "on_hand" | "revenue_30d_cents";

/**
 * Sort SKUs by a numeric metric, highest first. Stable (equal values keep the
 * input order) and non-mutating; a missing metric coerces to 0 so unsynced rows
 * sink to the bottom.
 */
export function sortSkus(skus: SkuVM[], key: SkuSortKey): SkuVM[] {
  return [...skus].sort((a, b) => Number(b[key] ?? 0) - Number(a[key] ?? 0));
}

/**
 * Default inventory ordering: most-stocked SKUs first — the load order merchants
 * see before choosing a sort.
 */
export function sortSkusByOnHandDesc(skus: SkuVM[]): SkuVM[] {
  return sortSkus(skus, "on_hand");
}

/**
 * "Needs attention" ranking by urgency (P2-13): soonest to run out first
 * (days_of_cover ASC), then higher 30-day revenue first as a tiebreaker so a
 * real best-seller outranks a zero-revenue sample at the same days-of-cover —
 * instead of the stock-DESC load order that buried the real at-risk SKUs.
 */
export function sortSkusByUrgency(skus: SkuVM[]): SkuVM[] {
  return [...skus].sort(
    (a, b) =>
      a.days_of_cover - b.days_of_cover ||
      Number(b.revenue_30d_cents ?? 0) - Number(a.revenue_30d_cents ?? 0),
  );
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

export async function fetchSkus(): Promise<SkuVM[]> {
  const data = await apiGet<{ skus: SKU[] }>("/dashboard/api/skus");
  return sortSkusByOnHandDesc(data.skus.map(adaptSku));
}

/** Per-SKU daily on-hand trend (90-day window) for the stock-trend sparkline.
 * Sparse, oldest-first; empty when the SKU has no in-window changes. */
export async function fetchSkuHistory(id: string): Promise<SkuHistoryPoint[]> {
  const data = await apiGet<{ history: SkuHistoryPoint[] }>(
    `/dashboard/api/skus/${encodeURIComponent(id)}/history`,
  );
  return data.history;
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

export async function fetchIntegrations(): Promise<IntegrationVM[]> {
  const data = await apiGet<{ integrations: Record<string, Integration> }>(
    "/dashboard/api/integrations",
  );
  return adaptIntegrations(data.integrations);
}

interface AnalyticsEnvelope {
  roas_series: DailyRoasRow[];
  grades: CampaignGradeRow[];
  top_ads: TopAdRow[];
}

export async function fetchAnalytics(): Promise<{
  daily: DailyRow[];
  grades: CampaignGradeRow[];
  topAds: TopAd[];
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
  };
}

// --- mutations -------------------------------------------------------------

interface CampaignActionInput {
  type: string;
  dailyBudgetCents?: number;
  alertId?: string;
}

export async function executeCampaignAction(
  campaignId: string,
  input: CampaignActionInput,
): Promise<{ auditId: string; outcome: string }> {
  const body: Record<string, unknown> = {
    type: input.type,
    idempotency_key: crypto.randomUUID(),
  };
  if (input.dailyBudgetCents !== undefined) body.daily_budget_cents = input.dailyBudgetCents;
  if (input.alertId !== undefined) body.alert_id = input.alertId;

  const data = await apiSend<{ audit_id: string; outcome: string }>(
    "POST",
    `/dashboard/api/campaigns/${encodeURIComponent(campaignId)}/action`,
    body,
  );
  // Note: 502 action_failed is surfaced as a DashboardApiError by apiSend, with
  // its auditId carried through from the response body.
  return { auditId: data.audit_id, outcome: data.outcome };
}

export async function executeAlertAction(
  alertId: string,
  input: { type: string },
): Promise<{ auditId: string; outcome: string; acknowledged: boolean }> {
  const data = await apiSend<{ audit_id: string; outcome: string; acknowledged: boolean }>(
    "POST",
    `/dashboard/api/alerts/${encodeURIComponent(alertId)}/action`,
    { type: input.type, idempotency_key: crypto.randomUUID() },
  );
  return { auditId: data.audit_id, outcome: data.outcome, acknowledged: data.acknowledged };
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

export async function getRealtimeToken(): Promise<{
  token: string;
  expiresAt: string;
} | null> {
  try {
    const data = await apiGet<{ token: string; expires_at: string }>(
      "/dashboard/api/realtime-token",
    );
    return { token: data.token, expiresAt: data.expires_at };
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

// --- calibration -------------------------------------------------------------

export async function fetchCalibration(): Promise<{
  pct: number | null;
  updated_at: string | null;
}> {
  const data = await apiGet<{ pct: number | null; updated_at: string | null }>(
    "/dashboard/api/calibration",
  );
  return { pct: data.pct, updated_at: data.updated_at };
}

export async function fetchActionQueue(): Promise<QueueProposalVM[]> {
  const data = await apiGet<{ proposals: QueueProposalVM[] }>("/dashboard/api/queue");
  return data.proposals;
}

// --- creative screener (Predictor) ------------------------------------------

export async function fetchLatestScreenRun(): Promise<CreativeScreenRun | null> {
  const data = await apiGet<{ latest: CreativeScreenRun | null }>("/dashboard/api/screener");
  return data.latest;
}

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

export async function screenCreative(
  payload: ScreenCreativePayload,
): Promise<CreativeScreenRun> {
  const data = await apiSend<{ run: CreativeScreenRun }>(
    "POST",
    "/dashboard/api/screener",
    payload,
  );
  return data.run;
}

/** Coerce a possibly null/undefined/NaN model number to a finite value so the
 * Predictor's `.toFixed(1)` / arithmetic renders can never throw. */
function fin(n: unknown, fallback = 0): number {
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
}

/** Live run DTO → the Scorecard view-model the Predictor screen renders. */
export function adaptScreenRun(run: CreativeScreenRun): Scorecard | null {
  const sc = run.scorecard;
  if (!sc) return null;
  return {
    ad_name:
      run.creativeInput?.headline?.trim() ||
      (run.source === "meta_ad" ? "Meta ad" : "Your ad"),
    composite: fin(sc.composite),
    grade: sc.grade,
    confidence: sc.confidence,
    summary: sc.summary,
    outcomes: {
      estimatedRoas: fin(sc.outcomes.estimatedRoas),
      roasLow: fin(sc.outcomes.roasLow),
      roasHigh: fin(sc.outcomes.roasHigh),
      breakEvenRoas: fin(sc.outcomes.breakEvenRoas),
      predictedCtr: fin(sc.outcomes.predictedCtr),
      holdRate: fin(sc.outcomes.holdRate),
      assumedSpendCents: fin(sc.outcomes.assumedSpendCents),
      predictedRevenueCents: fin(sc.outcomes.predictedRevenueCents),
      mappedSku: sc.outcomes.mappedSku ?? "No SKU",
      skuPriceCents: fin(sc.outcomes.skuPriceCents),
    },
    metrics: sc.metrics.map((m) => ({
      id: m.id,
      group: m.group,
      label: m.label,
      score: fin(m.score),
      reasoning: m.reasoning,
    })),
    tips: sc.tips,
    variants: run.variants.map((v) => ({
      mode: v.mode,
      composite: v.composite,
      delta: v.delta,
      summary: v.summary,
      headline: v.input.headline,
      cta: v.input.cta,
    })),
  };
}
