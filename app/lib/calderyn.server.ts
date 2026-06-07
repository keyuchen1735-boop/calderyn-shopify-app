import type {
  ActionKind,
  Alert,
  AuditEntry,
  Campaign,
  CampaignGradeRow,
  DailyRoasRow,
  GuardrailConfig,
  Integration,
  SKU,
  TopAdRow,
} from "./types";
import { getSupabase, resolveShopId } from "./supabase.server";
import { newIdempotencyKey } from "./ids";
import { buildAuthUrl } from "./meta/oauth.server";
import { buildAuthUrl as buildGoogleAuthUrl } from "./google/oauth.server";
import { buildAuthUrl as buildTikTokAuthUrl } from "./tiktok/oauth.server";
import { buildAuthUrl as buildQuickbooksAuthUrl } from "./quickbooks/oauth.server";
import { createOAuthState } from "./meta/oauth-state.server";
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

export type IntegrationProvider = "google" | "meta" | "tiktok" | "quickbooks";

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

/** ISO yyyy-mm-dd for `days` ago (date-only, for `day` column comparisons). */
function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

/** PostgREST embeds a many-to-one relation as an object (array in some cases). */
function embeddedName(rel: unknown): string {
  const obj = Array.isArray(rel) ? rel[0] : rel;
  return String((obj as { name?: unknown } | null)?.name ?? "");
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
    autopilot_enabled: Boolean(r.autopilot_enabled),
    autopilot_daily_action_cap: Number(r.autopilot_daily_action_cap ?? 3),
    autopilot_min_spend_cents: Number(r.autopilot_min_spend_cents ?? 20000),
    autopilot_max_budget_cut_pct: Number(r.autopilot_max_budget_cut_pct ?? 50),
  };
}

const INTEGRATION_LOGO_CLS: Record<string, string> = {
  shopify: "logo-shopify",
  meta_ads: "logo-meta",
  google_ads: "logo-google",
  tiktok_ads: "logo-tiktok",
  quickbooks: "logo-quickbooks",
};

const INTEGRATION_DISPLAY_NAME: Record<string, string> = {
  shopify: "Shopify",
  meta_ads: "Meta Ads",
  google_ads: "Google Ads",
  tiktok_ads: "TikTok Ads",
  quickbooks: "QuickBooks",
};

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

    analytics: {
      // Account-level daily spend+revenue over the window, aggregated for the
      // ROAS trend. ad_spend_fact has real data, so this renders immediately.
      async dailyRoasSeries(windowDays = 30, _signal?: AbortSignal): Promise<DailyRoasRow[]> {
        try {
          const shopId = await shopIdP;
          const since = isoDaysAgo(windowDays);
          const { data, error } = await supabase
            .from("ad_spend_fact")
            .select("day, spend_cents, revenue_attrib_cents")
            .eq("shop_id", shopId)
            .gte("day", since)
            .order("day", { ascending: true });
          if (error) throw error;
          const byDay = new Map<string, { spend: number; revenue: number }>();
          for (const r of data ?? []) {
            const day = String(r.day);
            const acc = byDay.get(day) ?? { spend: 0, revenue: 0 };
            acc.spend += Number(r.spend_cents ?? 0);
            acc.revenue += Number(r.revenue_attrib_cents ?? 0);
            byDay.set(day, acc);
          }
          return [...byDay.entries()]
            .sort((a, b) => (a[0] < b[0] ? -1 : 1))
            .map(([day, v]) => ({ day, spend_cents: v.spend, revenue_cents: v.revenue }));
        } catch (err) {
          rethrow("analytics.dailyRoasSeries", err);
        }
      },

      // Latest grade per campaign (most recent day_bucket), with its name.
      // Empty until the engine writes campaign_grade_fact.
      async campaignGrades(_signal?: AbortSignal): Promise<CampaignGradeRow[]> {
        try {
          const shopId = await shopIdP;
          const { data, error } = await supabase
            .from("campaign_grade_fact")
            .select(
              "campaign_id, grade, roas, break_even_roas, spend_cents, revenue_cents, day_bucket, ad_campaign_dim(name)",
            )
            .eq("shop_id", shopId)
            .order("day_bucket", { ascending: false });
          if (error) throw error;
          const seen = new Set<string>();
          const out: CampaignGradeRow[] = [];
          for (const r of data ?? []) {
            const campaignId = String(r.campaign_id);
            if (seen.has(campaignId)) continue;
            seen.add(campaignId);
            out.push({
              campaign_id: campaignId,
              name: embeddedName(r.ad_campaign_dim),
              grade: String(r.grade ?? ""),
              roas: Number(r.roas ?? 0),
              break_even_roas: Number(r.break_even_roas ?? 0),
              spend_cents: Number(r.spend_cents ?? 0),
              revenue_cents: Number(r.revenue_cents ?? 0),
              day_bucket: String(r.day_bucket ?? ""),
            });
          }
          return out;
        } catch (err) {
          rethrow("analytics.campaignGrades", err);
        }
      },

      // Top ads by total engagement over the window. Empty until Meta
      // engagement ingestion populates ad_engagement_fact.
      async topAdsByEngagement(
        windowDays = 30,
        limit = 20,
        _signal?: AbortSignal,
      ): Promise<TopAdRow[]> {
        try {
          const shopId = await shopIdP;
          const since = isoDaysAgo(windowDays);
          const { data, error } = await supabase
            .from("ad_engagement_fact")
            .select(
              "ad_external_id, ad_name, reactions, comments, shares, saves, ad_campaign_dim(name)",
            )
            .eq("shop_id", shopId)
            .gte("day", since);
          if (error) throw error;
          const byAd = new Map<string, TopAdRow>();
          for (const r of data ?? []) {
            const id = String(r.ad_external_id);
            const acc =
              byAd.get(id) ??
              ({
                ad_external_id: id,
                ad_name: String(r.ad_name ?? ""),
                campaign_name: embeddedName(r.ad_campaign_dim),
                reactions: 0,
                comments: 0,
                shares: 0,
                saves: 0,
                engagement: 0,
              } satisfies TopAdRow);
            acc.reactions += Number(r.reactions ?? 0);
            acc.comments += Number(r.comments ?? 0);
            acc.shares += Number(r.shares ?? 0);
            acc.saves += Number(r.saves ?? 0);
            acc.engagement = acc.reactions + acc.comments + acc.shares + acc.saves;
            byAd.set(id, acc);
          }
          return [...byAd.values()]
            .sort((a, b) => b.engagement - a.engagement)
            .slice(0, limit);
        } catch (err) {
          rethrow("analytics.topAdsByEngagement", err);
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
          if (patch.autopilot_enabled !== undefined) updates.autopilot_enabled = patch.autopilot_enabled;
          if (patch.autopilot_daily_action_cap !== undefined) updates.autopilot_daily_action_cap = patch.autopilot_daily_action_cap;
          if (patch.autopilot_min_spend_cents !== undefined) updates.autopilot_min_spend_cents = patch.autopilot_min_spend_cents;
          if (patch.autopilot_max_budget_cut_pct !== undefined) updates.autopilot_max_budget_cut_pct = patch.autopilot_max_budget_cut_pct;

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
            tiktok_ads: { name: "TikTok Ads", status: "disconnected", detail: "Not connected", logoCls: "logo-tiktok" },
            quickbooks: { name: "QuickBooks", status: "disconnected", detail: "Not connected", logoCls: "logo-quickbooks" },
          };

          for (const r of data ?? []) {
            const kind = String(r.kind);
            // Active-sync statuses the writers actually produce: Meta callback +
            // backfill write "ready"; the Google sync writes "live". All mean the
            // account is paired and data is flowing -> connected. "pending" is a
            // fresh pairing mid-backfill (still paired); anything else is not.
            const status: Integration["status"] =
              r.sync_status === "ready" || r.sync_status === "ok" || r.sync_status === "live"
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
          // Single-use, server-stored nonce bound to this shop (replaces the old
          // static HMAC-of-shop state). Consumed once at /auth/meta on callback.
          const shopId = await shopIdP;
          const state = await createOAuthState(supabase, shopId);
          return { redirectUrl: buildAuthUrl({ appId, redirectUri, state }) };
        }
        if (provider === "google") {
          const clientId = process.env.GOOGLE_ADS_CLIENT_ID;
          const clientSecret = process.env.GOOGLE_ADS_CLIENT_SECRET;
          const appUrl = process.env.SHOPIFY_APP_URL;
          if (!clientId || !clientSecret || !appUrl) {
            throw new CalderynError({
              code: "GOOGLE_NOT_CONFIGURED",
              status: 500,
              message:
                "Google Ads OAuth is not configured (GOOGLE_ADS_CLIENT_ID/GOOGLE_ADS_CLIENT_SECRET/SHOPIFY_APP_URL).",
            });
          }
          const redirectUri = `${appUrl}/auth/google`;
          // Same single-use nonce pattern as Meta; consumed once at /auth/google.
          const shopId = await shopIdP;
          const state = await createOAuthState(supabase, shopId);
          return { redirectUrl: buildGoogleAuthUrl({ clientId, redirectUri, state }) };
        }
        if (provider === "tiktok") {
          const appId = process.env.TIKTOK_APP_ID;
          const appSecret = process.env.TIKTOK_APP_SECRET;
          const appUrl = process.env.SHOPIFY_APP_URL;
          if (!appId || !appSecret || !appUrl) {
            throw new CalderynError({
              code: "TIKTOK_NOT_CONFIGURED",
              status: 500,
              message:
                "TikTok OAuth is not configured (TIKTOK_APP_ID/TIKTOK_APP_SECRET/SHOPIFY_APP_URL).",
            });
          }
          const redirectUri = `${appUrl}/auth/tiktok`;
          // Same single-use nonce pattern as Meta; consumed once at /auth/tiktok.
          const shopId = await shopIdP;
          const state = await createOAuthState(supabase, shopId);
          return { redirectUrl: buildTikTokAuthUrl({ appId, redirectUri, state }) };
        }
        if (provider === "quickbooks") {
          const clientId = process.env.QBO_CLIENT_ID;
          const clientSecret = process.env.QBO_CLIENT_SECRET;
          const appUrl = process.env.SHOPIFY_APP_URL;
          if (!clientId || !clientSecret || !appUrl) {
            throw new CalderynError({
              code: "QUICKBOOKS_NOT_CONFIGURED",
              status: 500,
              message:
                "QuickBooks OAuth is not configured (QBO_CLIENT_ID/QBO_CLIENT_SECRET/SHOPIFY_APP_URL).",
            });
          }
          const redirectUri = `${appUrl}/auth/quickbooks`;
          // Same single-use nonce pattern as Meta/Google; consumed once at /auth/quickbooks.
          const shopId = await shopIdP;
          const state = await createOAuthState(supabase, shopId);
          return { redirectUrl: buildQuickbooksAuthUrl({ clientId, redirectUri, state }) };
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
          const kind =
            provider === "meta"
              ? "meta_ads"
              : provider === "google"
                ? "google_ads"
                : provider === "tiktok"
                  ? "tiktok_ads"
                  : provider;
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
