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
  TopAdRow,
} from "~/lib/types";
import type {
  AlertVM,
  AuditVM,
  CampaignVM,
  DailyRow,
  GuardrailVM,
  Grade,
  IntegrationVM,
  OverviewVM,
  SkuVM,
  TopAd,
} from "~/components/dashboard/view-models";

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

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(path, {
    method: "GET",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
  });
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
  const campaign_id =
    a.campaign != null ? campaigns.find((c) => c.name === a.campaign)?.id ?? null : null;

  const actions = campaign_id
    ? ["pause_campaign", "reduce_campaign_budget", "snooze_alert"]
    : ["snooze_alert"];

  // recommended is the first concrete action; if all we can do is snooze there
  // is no recommendation to surface.
  const recommended = campaign_id ? actions[0] : null;

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

const VALID_GRADES: readonly Grade[] = ["winning", "okay", "poor"];

function coerceGrade(
  raw: string | undefined,
  roas: number | undefined,
  breakeven: number | undefined,
): Grade {
  if (raw && (VALID_GRADES as readonly string[]).includes(raw)) return raw as Grade;
  // Derive from economics only when we have a breakeven to compare against.
  if (typeof roas === "number" && typeof breakeven === "number" && breakeven > 0) {
    if (roas >= breakeven * 1.2) return "winning";
    if (roas >= breakeven) return "okay";
    return "poor";
  }
  return "okay";
}

export function adaptCampaign(c: Campaign, grades: CampaignGradeRow[]): CampaignVM {
  const g = grades.find((row) => row.campaign_id === c.id);
  const breakeven_roas = g?.break_even_roas ?? 0;
  const grade = coerceGrade(g?.grade, g?.roas ?? c.roas_7d, g?.break_even_roas);

  return {
    id: c.id,
    name: c.name,
    platform: c.platform,
    status: c.status,
    daily_budget_cents: c.daily_budget_cents,
    spend_7d: c.spend_7d,
    roas_7d: c.roas_7d,
    contribution_margin: c.contribution_margin,
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
  return {
    id: e.id,
    action_kind: e.action_kind,
    verb: AUDIT_VERBS[e.action_kind] ?? e.action_kind,
    target: e.target,
    detail: e.failure_reason ?? "",
    dollar_impact_at_exec: e.dollar_impact_at_exec,
    outcome: e.outcome,
    actor: e.actor,
    // The screen formats the timestamp; pass the raw ISO string through.
    when: e.created_at,
    undo_eligible: e.undo_eligible,
    pre: summarizeState(e.pre_state),
    post: summarizeState(e.post_state),
    failure: e.failure_reason,
  };
}

export function adaptSku(s: SKU): SkuVM {
  // The raw SKU type carries no sku-code or category field; fall back where the
  // view-model expects one. TODO(api): sku code + category on SKU.
  const skuCode = (s as { sku?: string }).sku ?? s.title;
  const category = (s as { category?: string }).category ?? "";

  const total = Object.values(s.locations ?? {}).reduce((sum, n) => sum + n, 0);
  const maxShare = total > 0 ? Math.max(0, ...Object.values(s.locations ?? {})) / total : 0;

  let status: string;
  if (s.on_hand === 0) status = "stockout";
  else if (s.days_of_cover < 10) status = "risk";
  else if (s.days_of_cover < 21) status = "reorder";
  else if (total > 0 && maxShare > 0.6) status = "misplaced";
  else status = "healthy";

  return {
    id: s.id,
    title: s.title,
    sku: skuCode,
    category,
    on_hand: s.on_hand,
    days_of_cover: s.days_of_cover,
    velocity: s.velocity,
    locations: s.locations,
    status,
  };
}

const INTEGRATION_ORDER = [
  "shopify",
  "meta_ads",
  "google_ads",
  "tiktok_ads",
  "quickbooks",
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

export async function fetchSkus(): Promise<SkuVM[]> {
  const data = await apiGet<{ skus: SKU[] }>("/dashboard/api/skus");
  return data.skus.map(adaptSku);
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
