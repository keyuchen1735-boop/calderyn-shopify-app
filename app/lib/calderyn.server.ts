import type {
  ActionKind,
  AdInsight,
  Alert,
  AnalyticsSummary,
  AuditEntry,
  Campaign,
  CampaignInsight,
  GuardrailConfig,
  Integration,
  SKU,
  TrendPoint,
} from "./types";
import { getSupabase, resolveShopId } from "./supabase.server";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  computeBreakEven,
  DEFAULT_MARGIN,
  COVERAGE_THRESHOLD,
  type BreakEvenResult,
} from "./analytics/breakeven";
import {
  rollupTrend,
  rollupSummary,
  rollupCampaigns,
  type CampaignDailyRow,
  type AdDailyRow,
} from "./analytics/rollup";
import { newIdempotencyKey } from "./ids";
import { buildAuthUrl, signState } from "./meta/oauth.server";
import { metaClientForShop } from "./meta/client.server";
import { setCampaignStatus } from "./meta/campaigns.server";

export class CalderynError extends Error {
  code: string;
  status: number;
  details: unknown;
  constructor(opts: { code: string; status: number; message: string; details?: unknown }) {
    super(opts.message);
    this.name = "CalderynError";
    this.code = opts.code;
    this.status = opts.status;
    this.details = opts.details;
  }
}

export type AlertFilters = {
  status?: string;
  severity?: string;
  detector?: string;
};

export type ExecuteActionOpts = {
  alertId: string | null;
  kind: ActionKind;
  params: Record<string, unknown>;
  idempotencyKey: string;
  preState?: unknown;
  postState?: unknown;
};

export type IntegrationProvider = "google" | "meta" | "quickbooks";

export type OnboardingState = { step: number; done: boolean };

const ONBOARDING_STEPS = [
  "shopify",
  "meta",
  "google",
  "quickbooks",
  "guardrails",
  "consent",
  "creative_mapping",
  "complete",
] as const;

type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

function rethrow(prefix: string, err: unknown): never {
  if (err instanceof CalderynError) throw err;
  const e = err as { message?: string; code?: string; details?: unknown };
  throw new CalderynError({
    code: e.code ?? "SUPABASE_ERROR",
    status: 500,
    message: `${prefix}: ${e.message ?? String(err)}`,
    details: e.details ?? err,
  });
}

function rowToAlert(r: Record<string, unknown>): Alert {
  return {
    id: String(r.id),
    detector_id: r.detector_id as Alert["detector_id"],
    severity: r.severity as Alert["severity"],
    status: r.status as Alert["status"],
    // DB stores dollars; UI helpers (fmtMoney) expect cents. Convert at the boundary.
    dollar_impact: Math.round(Number(r.dollar_impact ?? 0) * 100),
    claude_rank: Number(r.claude_rank ?? 999),
    created_at: String(r.created_at),
    title: String(r.title ?? ""),
    narrative: String(r.narrative ?? ""),
    campaign: (r.campaign as string | null) ?? null,
    sku: (r.sku as string | null) ?? null,
    evidence: (r.evidence as Record<string, unknown>) ?? {},
  };
}

function rowToAudit(r: Record<string, unknown>): AuditEntry {
  return {
    id: String(r.id),
    action_kind: r.action_kind as ActionKind,
    outcome: r.outcome as AuditEntry["outcome"],
    target: String(r.target ?? ""),
    dollar_impact_at_exec: Math.round(Number(r.dollar_impact_at_exec ?? 0) * 100),
    pre_state: r.pre_state,
    post_state: r.post_state,
    created_at: String(r.created_at),
    actor: String(r.actor ?? "system"),
    undo_eligible: Boolean(r.undo_eligible),
    alert_id: (r.alert_id as string | null) ?? null,
    detector_id: r.detector_id as AuditEntry["detector_id"],
    failure_reason: (r.failure_reason as string | undefined) ?? undefined,
    undo_of: (r.undo_of as string | undefined) ?? undefined,
  };
}

function rowToCampaign(r: Record<string, unknown>): Campaign {
  const platform = String(r.platform ?? "").toLowerCase();
  return {
    id: String(r.id),
    name: String(r.name),
    platform: platform === "google" ? "Google" : "Meta",
    status: r.status === "paused" ? "paused" : "active",
    daily_budget_cents: Number(r.daily_budget_cents ?? 0),
    roas_7d: Number(r.roas_7d ?? 0),
    contribution_margin: Number(r.contribution_margin ?? 0),
    spend_7d: Number(r.spend_7d_cents ?? 0),
  };
}

function rowToSku(r: Record<string, unknown>): SKU {
  return {
    id: String(r.id),
    title: String(r.title),
    on_hand: Number(r.on_hand ?? 0),
    days_of_cover: Number(r.days_of_cover ?? 0),
    velocity: Number(r.velocity ?? 0),
    locations: (r.locations as Record<string, number>) ?? {},
  };
}

function rowToGuardrails(r: Record<string, unknown>): GuardrailConfig {
  return {
    daily_action_budget_cents: Number(r.daily_action_budget ?? 0) * 100,
    daily_action_budget_used_cents: 0,
    dollar_cap_cents: Math.round(Number(r.dollar_impact_cap_without_2fa ?? 0) * 100),
    cooldown_minutes: Number(r.cooldown_minutes_per_campaign ?? 30),
    business_hours: {
      start: `${String(r.business_hours_start_utc ?? 14).padStart(2, "0")}:00`,
      end: `${String(r.business_hours_end_utc ?? 0).padStart(2, "0")}:00`,
      tz: String(r.timezone ?? "America/New_York"),
    },
    in_business_hours: true,
  };
}

const INTEGRATION_LOGO_CLS: Record<string, string> = {
  shopify: "logo-shopify",
  meta_ads: "logo-meta",
  google_ads: "logo-google",
  quickbooks: "logo-quickbooks",
};

const INTEGRATION_DISPLAY_NAME: Record<string, string> = {
  shopify: "Shopify",
  meta_ads: "Meta Ads",
  google_ads: "Google Ads",
  quickbooks: "QuickBooks",
};

export type AnalyticsWindow = 7 | 30 | 90;
const sinceISO = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

async function loadDaily(
  supabase: SupabaseClient,
  shopId: string,
  days: number,
): Promise<{ camp: CampaignDailyRow[]; ads: AdDailyRow[] }> {
  const since = sinceISO(days);
  const [campRes, adsRes] = await Promise.all([
    supabase.from("v_campaign_insights_daily").select("*").eq("shop_id", shopId).gte("day_bucket", since),
    supabase.from("v_ad_insights_daily").select("*").eq("shop_id", shopId).gte("day_bucket", since),
  ]);
  if (campRes.error) throw campRes.error;
  if (adsRes.error) throw adsRes.error;
  return { camp: (campRes.data ?? []) as CampaignDailyRow[], ads: (adsRes.data ?? []) as AdDailyRow[] };
}

async function loadBreakEven(supabase: SupabaseClient, shopId: string, days: number): Promise<BreakEvenResult> {
  const since = sinceISO(days);
  const [settingsRes, lineRes] = await Promise.all([
    supabase.from("analytics_settings").select("blended_margin_override").eq("shop_id", shopId).maybeSingle(),
    supabase
      .from("order_line_fact")
      .select("quantity, price_cents, sku_dim!inner(unit_cost_cents), order_fact!inner(shop_id, created_at)")
      .eq("order_fact.shop_id", shopId)
      .gte("order_fact.created_at", since),
  ]);
  if (settingsRes.error) throw settingsRes.error;
  if (lineRes.error) throw lineRes.error;
  const lines = (lineRes.data ?? []).map((r) => {
    const row = r as unknown as { quantity: number; price_cents: number; sku_dim: { unit_cost_cents: number | null } };
    return { price_cents: row.price_cents, quantity: row.quantity, unit_cost_cents: row.sku_dim?.unit_cost_cents ?? null };
  });
  const override =
    (settingsRes.data as { blended_margin_override?: number | null } | null)?.blended_margin_override ?? null;
  return computeBreakEven({ lines, override, defaultMargin: DEFAULT_MARGIN, coverageThreshold: COVERAGE_THRESHOLD });
}

// Open alerts with their campaign label, for linking to insights.
async function loadOpenAlertLinks(
  supabase: SupabaseClient,
  shopId: string,
): Promise<{ id: string; campaign: string | null }[]> {
  const { data, error } = await supabase
    .from("v_alerts_view").select("id, campaign, status")
    .eq("shop_id", shopId).eq("status", "open");
  if (error) throw error;
  return (data ?? []) as { id: string; campaign: string | null }[];
}

// Build {campaign_external_id -> alert ids} by matching each campaign's name
// against the alert's campaign label (substring), mirroring the existing
// name-link in app.campaigns.tsx. rollupCampaigns looks up by external id, so we
// bridge name -> id here. Runtime-reconciliation item: if alerts ever carry the
// Meta campaign id directly, key on that instead.
function alertLinksByCampaignId(
  alerts: { id: string; campaign: string | null }[],
  camp: CampaignDailyRow[],
): Record<string, string[]> {
  const nameById = new Map<string, string>();
  for (const c of camp) nameById.set(c.campaign_external_id, c.campaign_name);
  const out: Record<string, string[]> = {};
  for (const [externalId, name] of nameById) {
    if (!name) continue;
    const ids = alerts.filter((a) => a.campaign && a.campaign.includes(name)).map((a) => a.id);
    if (ids.length) out[externalId] = ids;
  }
  return out;
}

export function calderynClient(shop: string) {
  const supabase = getSupabase();
  const shopIdP = resolveShopId(shop);

  return {
    alerts: {
      async list(filters: AlertFilters = {}, _signal?: AbortSignal): Promise<Alert[]> {
        try {
          const shopId = await shopIdP;
          let q = supabase
            .from("v_alerts_view")
            .select("*")
            .eq("shop_id", shopId)
            .order("claude_rank", { ascending: true });
          if (filters.status && filters.status !== "all") q = q.eq("status", filters.status);
          if (filters.severity && filters.severity !== "all") q = q.eq("severity", filters.severity);
          if (filters.detector && filters.detector !== "all") q = q.eq("detector_id", filters.detector);
          const { data, error } = await q;
          if (error) throw error;
          return (data ?? []).map(rowToAlert);
        } catch (err) {
          rethrow("alerts.list", err);
        }
      },
      async get(id: string, _signal?: AbortSignal): Promise<Alert> {
        try {
          const shopId = await shopIdP;
          const { data, error } = await supabase
            .from("v_alerts_view")
            .select("*")
            .eq("shop_id", shopId)
            .eq("id", id)
            .maybeSingle();
          if (error) throw error;
          if (!data) {
            throw new CalderynError({ code: "ALERT_NOT_FOUND", status: 404, message: `Alert ${id} not found` });
          }
          return rowToAlert(data);
        } catch (err) {
          rethrow("alerts.get", err);
        }
      },
    },

    audit: {
      async list(_signal?: AbortSignal): Promise<AuditEntry[]> {
        try {
          const shopId = await shopIdP;
          const { data, error } = await supabase
            .from("v_audit_view")
            .select("*")
            .eq("shop_id", shopId)
            .order("created_at", { ascending: false })
            .limit(100);
          if (error) throw error;
          return (data ?? []).map(rowToAudit);
        } catch (err) {
          rethrow("audit.list", err);
        }
      },
      async undo(auditId: string, _signal?: AbortSignal): Promise<AuditEntry> {
        try {
          const shopId = await shopIdP;
          const { data: orig, error: oErr } = await supabase
            .from("action_audit")
            .select("*")
            .eq("shop_id", shopId)
            .eq("id", auditId)
            .maybeSingle();
          if (oErr) throw oErr;
          if (!orig) {
            throw new CalderynError({ code: "AUDIT_NOT_FOUND", status: 404, message: `Audit ${auditId} not found` });
          }

          // For real ad-platform pauses, restore the prior status on Meta first.
          if (orig.action_kind === "pause_campaign") {
            const priorStatus = (orig.pre_state as { status?: string } | null)?.status;
            const campaignId = (orig.post_state as { campaign_id?: string } | null)?.campaign_id;
            if (priorStatus === "ACTIVE" || priorStatus === "PAUSED") {
              const restore: "ACTIVE" | "PAUSED" = priorStatus;
              const meta = await metaClientForShop(shop);
              if (!meta || !campaignId) {
                throw new CalderynError({
                  code: "UNDO_META_UNAVAILABLE",
                  status: 400,
                  message: "Cannot undo: Meta is not connected or campaign id missing.",
                });
              }
              await setCampaignStatus(meta.client, campaignId, restore);
            }
          }

          const undoRow = {
            shop_id: shopId,
            alert_id: orig.alert_id,
            action_kind: orig.action_kind,
            params: { ...(orig.params ?? {}), undo_of: orig.id },
            outcome: "succeeded",
            pre_state: orig.post_state,
            post_state: orig.pre_state,
            dollar_impact_at_exec: orig.dollar_impact_at_exec ? -Number(orig.dollar_impact_at_exec) : 0,
            undo_of: orig.id,
            actor_user_id: "demo@calderyn.app",
            completed_at: new Date().toISOString(),
          };

          const { data: ins, error: iErr } = await supabase
            .from("action_audit")
            .insert(undoRow)
            .select()
            .single();
          if (iErr) throw iErr;

          const { data: view, error: vErr } = await supabase
            .from("v_audit_view")
            .select("*")
            .eq("id", ins.id)
            .single();
          if (vErr) throw vErr;
          return rowToAudit(view);
        } catch (err) {
          rethrow("audit.undo", err);
        }
      },
    },

    actions: {
      async execute(opts: ExecuteActionOpts, _signal?: AbortSignal): Promise<AuditEntry> {
        try {
          const shopId = await shopIdP;

          // Idempotency: return existing audit if key already used.
          const { data: prior, error: pErr } = await supabase
            .from("action_idempotency")
            .select("audit_id")
            .eq("shop_id", shopId)
            .eq("idempotency_key", opts.idempotencyKey)
            .maybeSingle();
          if (pErr) throw pErr;
          if (prior?.audit_id) {
            const { data: view, error: vErr } = await supabase
              .from("v_audit_view")
              .select("*")
              .eq("id", prior.audit_id)
              .single();
            if (vErr) throw vErr;
            return rowToAudit(view);
          }

          const target =
            (opts.params.campaign_name as string | undefined) ??
            (opts.params.sku as string | undefined) ??
            (opts.params.target as string | undefined) ??
            "";

          // For Phase 1 (no Python engines) executions just record an audit row.
          // The detector + action gateway will own the real pre/post state once wired.
          const { data: ins, error: iErr } = await supabase
            .from("action_audit")
            .insert({
              shop_id: shopId,
              alert_id: opts.alertId,
              action_kind: opts.kind,
              params: { ...opts.params, target },
              outcome: "succeeded",
              pre_state: opts.preState ?? null,
              post_state: opts.postState ?? opts.params,
              actor_user_id: "demo@calderyn.app",
              completed_at: new Date().toISOString(),
            })
            .select()
            .single();
          if (iErr) throw iErr;

          await supabase
            .from("action_idempotency")
            .insert({
              shop_id: shopId,
              idempotency_key: opts.idempotencyKey,
              audit_id: ins.id,
            });

          const { data: view, error: vErr } = await supabase
            .from("v_audit_view")
            .select("*")
            .eq("id", ins.id)
            .single();
          if (vErr) throw vErr;
          return rowToAudit(view);
        } catch (err) {
          rethrow("actions.execute", err);
        }
      },
    },

    campaigns: {
      async list(_signal?: AbortSignal): Promise<Campaign[]> {
        try {
          const shopId = await shopIdP;
          const { data, error } = await supabase
            .from("v_campaigns_flat")
            .select("*")
            .eq("shop_id", shopId)
            .order("spend_7d_cents", { ascending: false });
          if (error) throw error;
          return (data ?? []).map(rowToCampaign);
        } catch (err) {
          rethrow("campaigns.list", err);
        }
      },
    },

    skus: {
      async list(_signal?: AbortSignal): Promise<SKU[]> {
        try {
          const shopId = await shopIdP;
          const { data, error } = await supabase
            .from("v_skus_flat")
            .select("*")
            .eq("shop_id", shopId)
            .order("on_hand", { ascending: false });
          if (error) throw error;
          return (data ?? []).map(rowToSku);
        } catch (err) {
          rethrow("skus.list", err);
        }
      },
    },

    guardrails: {
      async get(_signal?: AbortSignal): Promise<GuardrailConfig> {
        try {
          const shopId = await shopIdP;
          const { data, error } = await supabase
            .from("guardrail_config")
            .select("*")
            .eq("shop_id", shopId)
            .maybeSingle();
          if (error) throw error;
          if (!data) {
            throw new CalderynError({
              code: "GUARDRAILS_NOT_FOUND",
              status: 404,
              message: `No guardrail config for shop ${shop}`,
            });
          }
          return rowToGuardrails(data);
        } catch (err) {
          rethrow("guardrails.get", err);
        }
      },
      async update(patch: Partial<GuardrailConfig>, _signal?: AbortSignal): Promise<GuardrailConfig> {
        try {
          const shopId = await shopIdP;
          const updates: Record<string, unknown> = {};
          if (patch.daily_action_budget_cents !== undefined) {
            updates.daily_action_budget = Math.round(patch.daily_action_budget_cents / 100);
          }
          if (patch.dollar_cap_cents !== undefined) {
            updates.dollar_impact_cap_without_2fa = patch.dollar_cap_cents / 100;
          }
          if (patch.cooldown_minutes !== undefined) {
            updates.cooldown_minutes_per_campaign = patch.cooldown_minutes;
          }
          if (patch.business_hours?.tz) updates.timezone = patch.business_hours.tz;

          if (Object.keys(updates).length > 0) {
            const { error } = await supabase
              .from("guardrail_config")
              .update(updates)
              .eq("shop_id", shopId);
            if (error) throw error;
          }

          const { data, error } = await supabase
            .from("guardrail_config")
            .select("*")
            .eq("shop_id", shopId)
            .single();
          if (error) throw error;
          return rowToGuardrails(data);
        } catch (err) {
          rethrow("guardrails.update", err);
        }
      },
    },

    integrations: {
      async list(_signal?: AbortSignal): Promise<Record<string, Integration>> {
        try {
          const shopId = await shopIdP;
          const { data, error } = await supabase
            .from("shop_integrations")
            .select("kind, sync_status, sync_error, connected_at, external_account_id")
            .eq("shop_id", shopId);
          if (error) throw error;

          const out: Record<string, Integration> = {
            shopify: { name: "Shopify", status: "connected", detail: shop, logoCls: "logo-shopify" },
            meta_ads: { name: "Meta Ads", status: "disconnected", detail: "Not connected", logoCls: "logo-meta" },
            google_ads: { name: "Google Ads", status: "disconnected", detail: "Not connected", logoCls: "logo-google" },
            quickbooks: { name: "QuickBooks", status: "disconnected", detail: "Not connected", logoCls: "logo-quickbooks" },
          };

          for (const r of data ?? []) {
            const kind = String(r.kind);
            const status: Integration["status"] =
              r.sync_status === "ready" || r.sync_status === "ok"
                ? "connected"
                : r.sync_status === "pending"
                  ? "pending"
                  : "disconnected";
            out[kind] = {
              name: INTEGRATION_DISPLAY_NAME[kind] ?? kind,
              status,
              detail: r.sync_error ?? r.external_account_id ?? (r.connected_at ? `Connected ${r.connected_at}` : "Pending"),
              logoCls: INTEGRATION_LOGO_CLS[kind] ?? "logo-default",
            };
          }
          return out;
        } catch (err) {
          rethrow("integrations.list", err);
        }
      },
      async startOAuth(provider: IntegrationProvider, _signal?: AbortSignal): Promise<{ redirectUrl: string }> {
        if (provider === "meta") {
          const appId = process.env.META_APP_ID;
          const appSecret = process.env.META_APP_SECRET;
          const appUrl = process.env.SHOPIFY_APP_URL;
          if (!appId || !appSecret || !appUrl) {
            throw new CalderynError({
              code: "META_NOT_CONFIGURED",
              status: 500,
              message: "Meta OAuth is not configured (META_APP_ID/META_APP_SECRET/SHOPIFY_APP_URL).",
            });
          }
          const redirectUri = `${appUrl}/auth/meta`;
          const state = signState(shop, appSecret);
          return { redirectUrl: buildAuthUrl({ appId, redirectUri, state }) };
        }
        throw new CalderynError({
          code: "OAUTH_NOT_WIRED",
          status: 501,
          message: `${provider} OAuth is not yet wired.`,
        });
      },
      async disconnect(provider: string, _signal?: AbortSignal): Promise<void> {
        try {
          const shopId = await shopIdP;
          const kind = provider === "meta" ? "meta_ads" : provider === "google" ? "google_ads" : provider;
          const { error } = await supabase
            .from("shop_integrations")
            .delete()
            .eq("shop_id", shopId)
            .eq("kind", kind);
          if (error) throw error;
        } catch (err) {
          rethrow("integrations.disconnect", err);
        }
      },
    },

    onboarding: {
      async getState(_signal?: AbortSignal): Promise<OnboardingState> {
        try {
          const shopId = await shopIdP;
          const { data, error } = await supabase
            .from("shops")
            .select("onboarding_step, onboarding_completed_at")
            .eq("id", shopId)
            .single();
          if (error) throw error;
          const stepIdx = ONBOARDING_STEPS.indexOf(data.onboarding_step as OnboardingStep);
          return {
            step: stepIdx >= 0 ? stepIdx : 0,
            done: Boolean(data.onboarding_completed_at) || data.onboarding_step === "complete",
          };
        } catch (err) {
          rethrow("onboarding.getState", err);
        }
      },
      async advance(step: number, _signal?: AbortSignal): Promise<void> {
        try {
          const shopId = await shopIdP;
          const clamped = Math.min(Math.max(step, 0), ONBOARDING_STEPS.length - 1);
          const stepName = ONBOARDING_STEPS[clamped];
          const updates: Record<string, unknown> = { onboarding_step: stepName };
          if (stepName === "complete") updates.onboarding_completed_at = new Date().toISOString();
          const { error } = await supabase.from("shops").update(updates).eq("id", shopId);
          if (error) throw error;
        } catch (err) {
          rethrow("onboarding.advance", err);
        }
      },
    },

    analytics: {
      async summary(days: AnalyticsWindow = 30): Promise<AnalyticsSummary> {
        try {
          const shopId = await shopIdP;
          const [{ camp, ads }, be] = await Promise.all([
            loadDaily(supabase, shopId, days),
            loadBreakEven(supabase, shopId, days),
          ]);
          return rollupSummary(camp, ads, {
            breakEvenRoas: be.breakEvenRoas,
            marginPct: be.margin,
            confidence: be.confidence,
            windowDays: days,
          });
        } catch (err) {
          rethrow("analytics.summary", err);
        }
      },
      async trend(days: AnalyticsWindow = 30): Promise<TrendPoint[]> {
        try {
          const shopId = await shopIdP;
          const { camp } = await loadDaily(supabase, shopId, days);
          return rollupTrend(camp);
        } catch (err) {
          rethrow("analytics.trend", err);
        }
      },
      async campaigns(days: AnalyticsWindow = 30): Promise<CampaignInsight[]> {
        try {
          const shopId = await shopIdP;
          const [{ camp, ads }, be, alerts] = await Promise.all([
            loadDaily(supabase, shopId, days),
            loadBreakEven(supabase, shopId, days),
            loadOpenAlertLinks(supabase, shopId),
          ]);
          const links = alertLinksByCampaignId(alerts, camp);
          return rollupCampaigns(camp, ads, be.breakEvenRoas, links);
        } catch (err) {
          rethrow("analytics.campaigns", err);
        }
      },
      async ads(campaignId: string, days: AnalyticsWindow = 30): Promise<AdInsight[]> {
        try {
          const shopId = await shopIdP;
          const { ads } = await loadDaily(supabase, shopId, days);
          const byAd = new Map<string, AdInsight & { _value_cents: number }>();
          for (const a of ads.filter((r) => r.campaign_external_id === campaignId)) {
            const cur =
              byAd.get(a.ad_external_id) ?? {
                ad_id: a.ad_external_id, campaign_id: campaignId, name: a.ad_name,
                spend_cents: 0, roas: 0, _value_cents: 0,
                engagement: { reactions: 0, comments: 0, shares: 0, saves: 0, post_engagement: 0 },
              };
            cur.spend_cents += a.spend_cents;
            cur._value_cents += a.purchase_value_cents;
            cur.engagement.reactions += a.reactions;
            cur.engagement.comments += a.comments;
            cur.engagement.shares += a.shares;
            cur.engagement.saves += a.saves;
            cur.engagement.post_engagement += a.post_engagement;
            byAd.set(a.ad_external_id, cur);
          }
          return [...byAd.values()]
            .map(({ _value_cents, ...ad }) => ({ ...ad, roas: ad.spend_cents > 0 ? _value_cents / ad.spend_cents : 0 }))
            .sort((x, y) => y.spend_cents - x.spend_cents);
        } catch (err) {
          rethrow("analytics.ads", err);
        }
      },
      settings: {
        async get(): Promise<{ marginOverride: number | null }> {
          try {
            const shopId = await shopIdP;
            const { data, error } = await supabase
              .from("analytics_settings").select("blended_margin_override").eq("shop_id", shopId).maybeSingle();
            if (error) throw error;
            return { marginOverride: (data?.blended_margin_override as number | null) ?? null };
          } catch (err) {
            rethrow("analytics.settings.get", err);
          }
        },
        async update(patch: { marginOverride: number | null }): Promise<void> {
          try {
            const shopId = await shopIdP;
            const { error } = await supabase
              .from("analytics_settings")
              .upsert(
                { shop_id: shopId, blended_margin_override: patch.marginOverride, updated_at: new Date().toISOString() },
                { onConflict: "shop_id" },
              );
            if (error) throw error;
          } catch (err) {
            rethrow("analytics.settings.update", err);
          }
        },
      },
    },

    internal: {
      async forwardWebhook(
        path: string,
        payload: unknown,
        headers: Record<string, string> = {},
        _signal?: AbortSignal,
      ): Promise<void> {
        try {
          const shopId = await shopIdP;
          const topic = headers["X-Shopify-Topic"] ?? path.split("/").pop() ?? "unknown";
          await supabase.from("raw_shopify_webhook").insert({
            shop_id: shopId,
            topic,
            webhook_id: headers["X-Shopify-Webhook-Id"] ?? `${topic}-${Date.now()}-${newIdempotencyKey()}`,
            hmac_verified: true,
            payload: payload as object,
          });
        } catch (err) {
          rethrow("internal.forwardWebhook", err);
        }
      },
    },
  };
}

export type CalderynClient = ReturnType<typeof calderynClient>;

export { newIdempotencyKey } from "./ids";
