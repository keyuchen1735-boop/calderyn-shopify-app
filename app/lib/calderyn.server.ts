import type {
  ActionKind,
  Alert,
  AuditEntry,
  Calibration,
  Campaign,
  CampaignGradeRow,
  CostSource,
  DailyRoasRow,
  DetectorId,
  GuardrailConfig,
  Integration,
  LearnedRule,
  QueueProposal,
  ShopLocation,
  SKU,
  SkuAffinityItem,
  SkuHistoryPoint,
  SkuSource,
  TopAdRow,
} from "./types";
import { rankMoves, toNumericEvidence } from "./remediation/rank";
import { synopsisFor } from "./remediation/synopsis";
import type { RemediationInput } from "./remediation/types";
import { buildActionQueue, inventoryOverCapAlertIds } from "./calibration/queue.server";
import { recordApproval as _recordApproval, type RecordApprovalOpts } from "./calibration/approval.server";
import { recordRejection as _recordRejection } from "./calibration/reject.server";
import { recomputeShopCalibration } from "./calibration/recompute.server";
import { countNearGraduation } from "./calibration/graduation.server";
import { liveEngineSummary, setPairAutonomy as _setPairAutonomy, type LiveEngineSummary, type PairEvidence } from "./calibration/live-engine.server";
import type { RecordRejectionInput } from "./calibration/reject.server";
import type { ApproveReceipt, RejectReceipt } from "./calibration/delta";
import { DETECTOR_LABELS, ACTION_LABELS } from "./labels";
import { AD_SPEND_ACTIONS, MARGIN_ACTIONS } from "./audit-legibility";
import {
  affinityFromRow,
  demandFromRow,
  locationsDetailFromRow,
  suggestedTransferFromRow,
  type SkuAffinityViewRow,
  type SkuDemandViewRow,
} from "./inventory-demand";
import { getSupabase, resolveShopId } from "./supabase.server";
import { encrypt } from "./crypto.server";
import { friendlyIntegrationError } from "./friendly-error";
import { newIdempotencyKey } from "./ids";
import { GRADE_ROWS_CAP } from "./actions/reallocation-suggest.server";
import { buildAuthUrl } from "./meta/oauth.server";
import { buildAuthUrl as buildGoogleAuthUrl } from "./google/oauth.server";
import { buildAuthUrl as buildTikTokAuthUrl } from "./tiktok/oauth.server";
import { buildAuthUrl as buildQuickbooksAuthUrl } from "./quickbooks/oauth.server";
import { buildAuthUrl as buildShippoAuthUrl } from "./shippo/oauth.server";
import { refreshShipHeroToken } from "./shiphero/auth.server";
import { createOAuthState } from "./meta/oauth-state.server";
import { undoAction } from "./actions/undo.server";
import { withinBusinessHours } from "./actions/guardrails";
import { localHourToUtc, utcHourToLocal } from "./dashboard/business-hours";
import { DEFAULT_GUARDRAILS } from "./guardrail-defaults";
import { recoveredDollarsForAlertAction } from "./actions/execute.server";
import { dailyActionBudgetUsedCents } from "./recovered";

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
  /** Who triggered this action. Defaults to "merchant" when absent. */
  actor?: string;
  /** Plain-language reason persisted to action_audit.trigger_reason. Autopilot
   *  sets it; manual paths leave it undefined. */
  triggerReason?: string | null;
  /** Which system a routed store write landed in (extend:write-back), persisted to
   *  action_audit.write_target. `shopify_admin` | `owned_sot`; null/undefined for
   *  non-store actions. */
  writeTarget?: "shopify_admin" | "owned_sot" | null;
};

// OAuth providers + API-key providers (EasyPost ship-cost connector, contract C8).
// startOAuth handles the OAuth set; connectApiKey handles the API-key set.
export type IntegrationProvider =
  | "google"
  | "meta"
  | "tiktok"
  | "quickbooks"
  | "easypost" // Phase 1 — ship-cost, API-key connect (connectApiKey).
  | "shippo" // Phase 2 — ship-cost, co-branded OAuth connect (startOAuth).
  | "shipbob" // Phase 3 Part B — 3PL house, API-key (PAT) connect (connectApiKey).
  | "shiphero"; // Phase 3 Part B — 3PL house, credential/refresh-token paste (connectApiKey).

export type OnboardingState = { step: number; done: boolean };

// MUST mirror the wizard's STEPS order in routes/app.onboarding.tsx — the DB
// stores the step NAME, so a divergent order here persists a step the merchant
// is not actually on (and any other surface reading shops.onboarding_step
// would resume them at the wrong place).
// 5-step model (2026-06 onboarding redesign): the four ad/accounting OAuth
// providers collapsed from one step each into a single "connect" screen, and the
// creative-mapping step was dropped. Persisted in shops.onboarding_step; the index
// drives the wizard. postOAuthPath still keys off "complete"/onboarding_completed_at.
const ONBOARDING_STEPS = [
  "shopify",
  "guardrails",
  "connect",
  "consent",
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

const PRODUCT_ECON_DETECTORS: ReadonlySet<DetectorId> = new Set<DetectorId>([
  "negative_unit_economics",
  "ad_tax_overload",
  "return_rate_hidden_loss",
  "margin_erosion",
  "cogs_drift",
]);

/** Compute the remediation plan + synopsis for product-economics alerts and
 *  attach them to the Alert. Pure, no I/O — evidence already carries the per-unit
 *  economics the engine needs. Exported for unit tests. */
export function attachRemediation(a: Alert): Alert {
  if (!PRODUCT_ECON_DETECTORS.has(a.detector_id)) {
    return { ...a, remediation: null, rec_detail: "" };
  }
  const input: RemediationInput = {
    detectorId: a.detector_id,
    dollarImpactCents: a.dollar_impact,
    evidence: toNumericEvidence(a.evidence),
  };
  const plan = rankMoves(input);
  return { ...a, remediation: plan, rec_detail: synopsisFor(plan, input) };
}

function rowToAlert(r: Record<string, unknown>): Alert {
  const base: Alert = {
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
    campaign_id: (r.campaign_id as string | null) ?? null,
    campaign_external_id: (r.campaign_external_id as string | null) ?? null,
    sku: (r.sku as string | null) ?? null,
    evidence: (r.evidence as Record<string, unknown>) ?? {},
    remediation: null,
    rec_detail: "",
  };
  return attachRemediation(base);
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
    trigger_reason: (r.trigger_reason as string | null) ?? null,
    cost_sources: (r.cost_sources as AuditEntry["cost_sources"]) ?? [],
  };
}

function rowToCampaign(r: Record<string, unknown>): Campaign {
  const platform = String(r.platform ?? "").toLowerCase();
  return {
    id: String(r.id),
    name: String(r.name),
    platform: platform === "google" ? "Google" : platform === "tiktok" ? "TikTok" : "Meta",
    status: r.status === "paused" ? "paused" : "active",
    daily_budget_cents: Number(r.daily_budget_cents ?? 0),
    roas_7d: Number(r.roas_7d ?? 0),
    contribution_margin: Number(r.contribution_margin ?? 0),
    spend_7d: Number(r.spend_7d_cents ?? 0),
  };
}

const SKU_SOURCE_ORDER: SkuSource[] = [
  "quickbooks",
  "vendor_invoice",
  "google",
  "meta",
  "tiktok",
];

function isSkuSource(v: string): v is SkuSource {
  return (SKU_SOURCE_ORDER as string[]).includes(v);
}

function rowToSku(r: Record<string, unknown>, sources: SkuSource[] = []): SKU {
  return {
    id: String(r.id),
    title: String(r.title),
    sku: String(r.sku ?? ""),
    on_hand: Number(r.on_hand ?? 0),
    days_of_cover: Number(r.days_of_cover ?? 0),
    velocity: Number(r.velocity ?? 0),
    locations: (r.locations as Record<string, number>) ?? {},
    sources,
    demand: null,
    suggested_transfer: null,
    locations_detail: [],
    ship_cost_source: (r.ship_cost_source as SKU["ship_cost_source"]) ?? null,
    ship_cost_confidence: (r.ship_cost_confidence as SKU["ship_cost_confidence"]) ?? null,
    ship_pnl_cents: r.ship_pnl_cents == null ? null : Number(r.ship_pnl_cents),
    do_not_reorder: r.do_not_reorder === true,
  };
}

/** Plain-language summary for a calibration_rule row, shown in the Learned Rules list. */
function ruleSummary(r: { detector_id: string; action_kind: ActionKind; rule_kind: string; rule_value: unknown }): string {
  const detector = DETECTOR_LABELS[r.detector_id as keyof typeof DETECTOR_LABELS] ?? r.detector_id;
  const action = ACTION_LABELS[r.action_kind]?.toLowerCase() ?? r.action_kind;
  const label = `${action} on ${detector}`;
  const val = r.rule_value as Record<string, unknown> | null;
  switch (r.rule_kind) {
    case "muted_pair":
      return `I leave ${label} to you`;
    case "pair_dollar_cap": {
      const cents = Number(val?.cents ?? 0);
      const dollars = (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
      return `I will not go bigger than ${dollars} on ${label}`;
    }
    case "pair_probation_until": {
      const iso = String(val?.until ?? "");
      const date = iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "a future date";
      return `Waiting for more proof on ${label} until ${date}`;
    }
    case "pair_blackout_hours": {
      const hours = Array.isArray(val?.hours) ? (val.hours as number[]) : [];
      const fmtHour = (h: number) => `${String(h).padStart(2, "0")}:00`;
      const windows = hours.map((h) => `${fmtHour(h)}–${fmtHour((h + 1) % 24)} UTC`).join(", ");
      return windows
        ? `I hold off on ${label} during ${windows}`
        : `I hold off on ${label} during your learned quiet hours`;
    }
    case "pair_min_spend": {
      const cents = Number(val?.cents ?? 0);
      const dollars = (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
      return `I skip ${label} under ${dollars} of spend`;
    }
    default:
      return `Rule on ${label}`;
  }
}

// Start of the current UTC day — the window the daily action budget resets on,
// matching the autopilot guardrail enforcement (actions/guardrails.server.ts).
function startOfUtcDayIso(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

function rowToGuardrails(r: Record<string, unknown>, usedCents = 0): GuardrailConfig {
  const tz = String(r.timezone ?? "America/New_York");
  const startUtc = Number(r.business_hours_start_utc ?? 14);
  const endUtc = Number(r.business_hours_end_utc ?? 0);
  return {
    daily_action_budget_cents: Number(r.daily_action_budget ?? 0) * 100,
    daily_action_budget_used_cents: usedCents,
    dollar_cap_cents: Math.round(Number(r.dollar_impact_cap_without_2fa ?? 0) * 100),
    cooldown_minutes: Number(r.cooldown_minutes_per_campaign ?? 30),
    business_hours: {
      start: utcHourToLocal(startUtc, tz),
      end: utcHourToLocal(endUtc, tz),
      tz,
    },
    business_hours_only: Boolean(r.business_hours_only),
    // Same window math the autopilot gateway enforces (actions/guardrails.ts),
    // so the merchant-facing check can't show green while the gateway blocks.
    in_business_hours: withinBusinessHours(startUtc, endUtc, new Date().getUTCHours()),
    autopilot_enabled: Boolean(r.autopilot_enabled),
    autopilot_bypass_guardrails: Boolean(r.autopilot_bypass_guardrails),
    // null column = no cap (unlimited); preserve it rather than coercing to a number.
    autopilot_daily_action_cap:
      r.autopilot_daily_action_cap == null ? null : Number(r.autopilot_daily_action_cap),
    autopilot_min_spend_cents: Number(r.autopilot_min_spend_cents ?? 20000),
    autopilot_max_budget_cut_pct: Number(r.autopilot_max_budget_cut_pct ?? 50),
    autopilot_max_budget_increase_pct: Number(r.autopilot_max_budget_increase_pct ?? 20),
    autopilot_max_daily_budget_cents:
      r.autopilot_max_daily_budget_cents == null ? null : Number(r.autopilot_max_daily_budget_cents),
    max_price_change_pct: Number(r.max_price_change_pct ?? 15),
    autopilot_max_price_change_pct: Number(r.autopilot_max_price_change_pct ?? 10),
    autopilot_max_inventory_units_per_move:
      r.autopilot_max_inventory_units_per_move == null
        ? null
        : Number(r.autopilot_max_inventory_units_per_move),
  };
}

const INTEGRATION_LOGO_CLS: Record<string, string> = {
  shopify: "logo-shopify",
  meta_ads: "logo-meta",
  google_ads: "logo-google",
  tiktok_ads: "logo-tiktok",
  quickbooks: "logo-quickbooks",
  easypost_ship: "logo-easypost",
  shippo_ship: "logo-shippo",
  shipbob_ship: "logo-shipbob",
  shiphero_ship: "logo-shiphero",
};

const INTEGRATION_DISPLAY_NAME: Record<string, string> = {
  shopify: "Shopify",
  meta_ads: "Meta Ads",
  google_ads: "Google Ads",
  tiktok_ads: "TikTok Ads",
  quickbooks: "QuickBooks",
  easypost_ship: "EasyPost",
  shippo_ship: "Shippo",
  shipbob_ship: "ShipBob",
  shiphero_ship: "ShipHero",
};

/**
 * Live-probe a pasted EasyPost API key BEFORE we persist it, so a bad key is
 * rejected at the connect boundary with a visible error and NO credential is
 * written (success criterion #1, rule 12). EasyPost auth is HTTP Basic with the
 * key as username + empty password — base64("KEY:"), NOT Bearer (docs.easypost.com),
 * matching adapters/easypost.server.ts. Reads EASYPOST_API_BASE for env parity with
 * the cron. `fetchImpl` is injectable so the connect flow can be unit-tested without
 * the network. Throws a CalderynError on any non-2xx (401 bad key, 429, …); the
 * action surfaces it as a toast. We do NOT keep the base-64 helper in the server-core
 * adapter file (left untouched) — this is a deliberate ~1-line duplication.
 */
async function probeEasyPostKey(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const raw = process.env.EASYPOST_API_BASE?.trim();
  const base = (raw && raw.length > 0 ? raw : "https://api.easypost.com/v2").replace(/\/+$/, "");
  const auth = `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`;
  let res: Response;
  try {
    res = await fetchImpl(`${base}/shipments?page_size=1`, {
      method: "GET",
      headers: { Authorization: auth, Accept: "application/json" },
    });
  } catch (err) {
    throw new CalderynError({
      code: "EASYPOST_UNREACHABLE",
      status: 502,
      message: `Couldn't reach EasyPost to verify the key: ${(err as Error).message}`,
    });
  }
  if (!res.ok) {
    const snippet = (await res.text().catch(() => "")).slice(0, 200);
    const friendly =
      res.status === 401
        ? "That EasyPost API key was rejected (401). Paste your production API key from the EasyPost dashboard."
        : `EasyPost rejected the key (${res.status}). ${snippet}`;
    throw new CalderynError({ code: "EASYPOST_KEY_INVALID", status: 400, message: friendly });
  }
}

/**
 * Live-probe a pasted ShipBob Personal Access Token BEFORE we persist it (Phase 3 Part B),
 * so a bad/under-scoped PAT is rejected at the connect boundary with NO credential written
 * (rule 12). ShipBob auth is a Bearer PAT; the cheapest authenticated read that confirms
 * both validity AND the billing_read scope is a 1-row Billing transactions query (the same
 * endpoint the adapter polls — adapters/shipbob.server.ts). Reads SHIPBOB_API_BASE for env
 * parity with the cron. `fetchImpl` is injectable for tests. Throws a CalderynError on any
 * non-2xx (401 bad PAT, 403 missing scope, 429); the action surfaces it as a toast.
 */
async function probeShipBobKey(
  pat: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const raw = process.env.SHIPBOB_API_BASE?.trim();
  const base = (raw && raw.length > 0 ? raw : "https://api.shipbob.com/2026-01").replace(/\/+$/, "");
  let res: Response;
  try {
    res = await fetchImpl(`${base}/transactions:query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ Page: 1, PageSize: 1 }),
    });
  } catch (err) {
    throw new CalderynError({
      code: "SHIPBOB_UNREACHABLE",
      status: 502,
      message: `Couldn't reach ShipBob to verify the token: ${(err as Error).message}`,
    });
  }
  if (!res.ok) {
    const snippet = (await res.text().catch(() => "")).slice(0, 200);
    const friendly =
      res.status === 401
        ? "That ShipBob token was rejected (401). Paste a Personal Access Token with the billing_read scope."
        : res.status === 403
          ? "That ShipBob token is missing the billing_read scope (403). Re-issue it with billing_read."
          : `ShipBob rejected the token (${res.status}). ${snippet}`;
    throw new CalderynError({ code: "SHIPBOB_KEY_INVALID", status: 400, message: friendly });
  }
}

/**
 * Live-probe a pasted ShipHero REFRESH token BEFORE we persist it (Phase 3 Part B), so a
 * bad/expired refresh token is rejected at the connect boundary with NO credential written
 * (rule 12). ShipHero is credential/token-based, NOT OAuth: the cheapest validation that the
 * pasted token actually works is to perform the same /auth/refresh the cost adapter runs each
 * sync — a valid refresh token mints an access token; a bad one throws (401 / no token).
 * `fetchImpl` is injectable for tests. The underlying refresh error never echoes the token;
 * we re-wrap it as a friendly CalderynError the action surfaces as a toast.
 *
 * ⚠️ LIVE-VERIFICATION TODO (b): a self-serve 3rd-Party-Developer refresh token mints an
 * access token here, but whether that token carries the GraphQL scopes the adapter's
 * `shipping_labels { cost }` query needs is NOT yet confirmed against a live account — this
 * probe proves the token refreshes, not that it can read label cost. (Confirmed per onboarded
 * account; the zero-cost guard in adapters/shiphero.server.ts further gates the cost claim.)
 */
async function probeShipHeroToken(
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  try {
    await refreshShipHeroToken(refreshToken, fetchImpl);
  } catch (err) {
    // refreshShipHeroToken already strips the token from its message; surface a friendly,
    // actionable error without leaking the pasted secret.
    const msg = (err as Error).message ?? "ShipHero rejected the refresh token.";
    throw new CalderynError({
      code: "SHIPHERO_TOKEN_INVALID",
      status: 400,
      message: `That ShipHero refresh token was rejected. Paste the Refresh Token from ShipHero → My Account → Developer Users. (${msg.slice(0, 160)})`,
    });
  }
}

export function calderynClient(shop: string) {
  const supabase = getSupabase();
  const shopIdP = resolveShopId(shop);

  // Shared helper: fetch all open alerts for a shop, ordered by claude_rank.
  // Used by both alerts.list({status:"open"}) and queue.list — single source of
  // truth so the open-alerts query is never duplicated.
  async function fetchOpenAlerts(shopId: string): Promise<Alert[]> {
    const { data, error } = await supabase
      .from("v_alerts_view")
      .select("*")
      .eq("shop_id", shopId)
      .eq("status", "open")
      .order("claude_rank", { ascending: true });
    if (error) throw error;
    return (data ?? []).map(rowToAlert);
  }

  // Dollars (in cents) the shop's actions have recovered since the start of the
  // UTC day — the "used" half of the daily action budget meter. Same inclusion
  // rule as the Recovered-impact total, windowed to today.
  async function dailyUsedCents(shopId: string): Promise<number> {
    const since = startOfUtcDayIso();
    // A failed lookup must degrade the "used" meter to 0, not blank the whole
    // guardrails tile — the cap and every other setting still load. Same
    // fallback the impact write uses (actions/execute.server.ts).
    try {
      const { data, error } = await supabase
        .from("action_audit")
        // id is load-bearing: recovered() claws back an undone action by
        // matching undo_of against the original row's id — without it the
        // meter keeps counting actions the merchant has undone.
        .select("id, outcome, dollar_impact_at_exec, undo_of, created_at")
        .eq("shop_id", shopId)
        .gte("created_at", since);
      if (error) throw error;
      const rows = (data ?? []).map((r) => ({
        id: String(r.id),
        outcome: String(r.outcome),
        // DB stores dollars; the budget meter (and the helper) work in cents.
        dollar_impact_at_exec: Math.round(Number(r.dollar_impact_at_exec ?? 0) * 100),
        undo_of: (r.undo_of as string | null) ?? null,
        created_at: String(r.created_at),
      }));
      return dailyActionBudgetUsedCents(rows, since);
    } catch (err) {
      console.error(`[guardrails] daily action budget used lookup failed for shop ${shopId}`, err);
      return 0;
    }
  }

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
          const rows = data ?? [];

          // Resolve a COGS source per margin-action row. Precedence (hybrid):
          //   1. per-SKU sku_cost_history.source (precise: quickbooks vs vendor_invoice)
          //   2. the shop's connected cost integration (QuickBooks live -> "quickbooks")
          //   3. "shopify" (unit_cost synced from Shopify); "unavailable" only on error.
          // Inventory rows carry a sku_id (uuid); create_po_draft carries a sku CODE in
          // param_po_sku that must be resolved to a sku_id, shop-scoped (codes collide
          // across shops).
          const skuIdByCode = new Map<string, string>();
          const cogsBySkuId = new Map<string, string>();
          let connectedCostSource = "shopify";
          const marginRows = rows.filter((r) =>
            MARGIN_ACTIONS.has(String(r.action_kind) as ActionKind),
          );
          if (marginRows.length > 0) {
            try {
              const codes = Array.from(
                new Set(
                  marginRows
                    .map((r) => (r.param_po_sku ? String(r.param_po_sku) : ""))
                    .filter(Boolean),
                ),
              );
              if (codes.length > 0) {
                const { data: dims, error: dErr } = await supabase
                  .from("sku_dim")
                  .select("id, sku")
                  .eq("shop_id", shopId)
                  .in("sku", codes);
                if (dErr) throw dErr;
                for (const d of dims ?? []) skuIdByCode.set(String(d.sku), String(d.id));
              }

              const skuIds = Array.from(
                new Set(
                  [
                    ...marginRows.map((r) => (r.param_sku_id ? String(r.param_sku_id) : "")),
                    ...codes.map((c) => skuIdByCode.get(c) ?? ""),
                  ].filter(Boolean),
                ),
              );
              if (skuIds.length > 0) {
                const { data: costs, error: cErr } = await supabase
                  .from("sku_cost_history")
                  .select("sku_id, source, effective_from")
                  .in("sku_id", skuIds);
                if (cErr) throw cErr;
                // Keep the latest-effective source per sku.
                const latest = new Map<string, string>();
                for (const c of costs ?? []) {
                  const k = String(c.sku_id);
                  const ef = String(c.effective_from);
                  if (!latest.has(k) || ef > (latest.get(k) as string)) {
                    latest.set(k, ef);
                    cogsBySkuId.set(k, String(c.source));
                  }
                }
              }

              // Fallback source: the shop's connected cost integration.
              const { data: qb } = await supabase
                .from("shop_integrations")
                .select("sync_status")
                .eq("shop_id", shopId)
                .eq("kind", "quickbooks")
                .maybeSingle();
              const s = qb?.sync_status;
              if (s === "ready" || s === "ok" || s === "live" || s === "pending") {
                connectedCostSource = "quickbooks";
              }
            } catch (err) {
              // Fail visibly (rule 12): the log still loads; margin rows fall back to
              // "unavailable" rather than blanking the whole audit page.
              console.error(`[audit] cost-source lookup failed for shop ${shopId}`, err);
              connectedCostSource = "unavailable";
            }
          }

          const cogsSourceFor = (r: Record<string, unknown>): string => {
            const skuId = r.param_sku_id
              ? String(r.param_sku_id)
              : r.param_po_sku
                ? skuIdByCode.get(String(r.param_po_sku)) ?? ""
                : "";
            return (skuId && cogsBySkuId.get(skuId)) || connectedCostSource;
          };

          return rows.map((r) => {
            const kind = String(r.action_kind) as ActionKind;
            const cost_sources: CostSource[] = [];
            if (AD_SPEND_ACTIONS.has(kind) && r.param_platform) {
              cost_sources.push({ kind: "ad_spend", source: String(r.param_platform) });
            } else if (MARGIN_ACTIONS.has(kind)) {
              cost_sources.push({ kind: "price", source: "shopify" });
              cost_sources.push({ kind: "cogs", source: cogsSourceFor(r) });
            }
            return rowToAudit({ ...r, cost_sources });
          });
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

          // Platform-reversible kinds delegate to the action-gateway undo
          // instead of the legacy path below. undoAction resolves the RIGHT
          // platform adapter (meta/google/tiktok) from the campaign, reverses
          // through it, restores ad_campaign_dim, and re-opens the alert; for
          // inventory it fires the reverse Shopify transfer. The old path here
          // forced every status undo through the Meta client, so a TikTok or
          // Google undo either failed (UNDO_META_UNAVAILABLE) or hit Meta with a
          // foreign campaign id — and recorded inventory "undos" that never
          // touched Shopify (rule 12). The legacy manual-insert path below now
          // only serves non-platform kinds (e.g. create_po_draft) that have no
          // platform reversal — they just record the inverse audit row.
          const GATEWAY_UNDO_KINDS = new Set([
            "reallocate_budget",
            "pause_campaign",
            "resume_campaign",
            "reduce_campaign_budget",
            "reallocate_inventory",
            "push_creative_draft",
          ]);
          if (GATEWAY_UNDO_KINDS.has(String(orig.action_kind))) {
            // Lazy import: ~/shopify.server initializes shopifyApp (env,
            // Prisma session storage) at module load — keep it out of the
            // module graph of every test that imports calderyn.server.
            const deps =
              orig.action_kind === "reallocate_inventory"
                ? { admin: (await (await import("~/shopify.server")).unauthenticated.admin(shop)).admin }
                : {};
            const res = await undoAction(shopId, auditId, supabase, deps);
            const { data: view, error: vErr } = await supabase
              .from("v_audit_view")
              .select("*")
              .eq("id", res.id)
              .eq("shop_id", shopId)
              .single();
            if (vErr) throw vErr;
            return rowToAudit(view);
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
            actor_user_id: "merchant",
            completed_at: new Date().toISOString(),
          };

          const { data: ins, error: iErr } = await supabase
            .from("action_audit")
            .insert(undoRow)
            .select()
            .single();
          if (iErr) throw iErr;

          // Undo revives the underlying problem: acknowledge-on-execute
          // closed the alert, so reversing the action puts it back in the
          // open queue. Best-effort — log, don't fail the recorded undo.
          if (orig.alert_id) {
            const { error: reopenErr } = await supabase
              .from("alerts")
              .update({ status: "open" })
              .eq("shop_id", shopId)
              .eq("id", orig.alert_id)
              .eq("status", "acknowledged");
            if (reopenErr) {
              console.error(`[audit] failed to re-open alert ${orig.alert_id} after undo`, reopenErr);
            }
          }

          const { data: view, error: vErr } = await supabase
            .from("v_audit_view")
            .select("*")
            .eq("id", ins.id)
            .eq("shop_id", shopId)
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
              .eq("shop_id", shopId)
              .single();
            if (vErr) throw vErr;
            return rowToAudit(view);
          }

          const target =
            (opts.params.campaign_name as string | undefined) ??
            (opts.params.sku as string | undefined) ??
            (opts.params.target as string | undefined) ??
            "";

          // Recovered impact: value-recovering kinds that execute on this
          // legacy path (create_po_draft, exclude_geo, reallocate_inventory)
          // must record their clawed-back dollars too, or they never count
          // toward the Recovered-impact total.
          const dollarImpactAtExec = await recoveredDollarsForAlertAction(
            supabase,
            opts.alertId,
            opts.kind,
            shopId,
          );

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
              dollar_impact_at_exec: dollarImpactAtExec,
              pre_state: opts.preState ?? null,
              post_state: opts.postState ?? opts.params,
              actor_user_id: opts.actor ?? "merchant",
              trigger_reason: opts.triggerReason ?? null,
              write_target: opts.writeTarget ?? null,
              completed_at: new Date().toISOString(),
            })
            .select()
            .single();
          if (iErr) throw iErr;

          const { error: idemErr } = await supabase
            .from("action_idempotency")
            .insert({
              shop_id: shopId,
              idempotency_key: opts.idempotencyKey,
              audit_id: ins.id,
            });
          if (idemErr) {
            // The audit row exists — failing now would provoke the duplicate
            // execution the key prevents. Surface the lost dedup protection
            // loudly instead (rule 12).
            console.error(`[actions] idempotency insert failed for audit ${ins.id} (key ${opts.idempotencyKey})`, idemErr);
          }

          const { data: view, error: vErr } = await supabase
            .from("v_audit_view")
            .select("*")
            .eq("id", ins.id)
            .eq("shop_id", shopId)
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
      async get(id: string, _signal?: AbortSignal): Promise<Campaign> {
        try {
          const shopId = await shopIdP;
          const { data, error } = await supabase
            .from("v_campaigns_flat")
            .select("*")
            .eq("shop_id", shopId)
            .eq("id", id)
            .maybeSingle();
          if (error) throw error;
          if (!data) {
            throw new CalderynError({
              code: "CAMPAIGN_NOT_FOUND",
              status: 404,
              message: `Campaign ${id} not found`,
            });
          }
          return rowToCampaign(data);
        } catch (err) {
          rethrow("campaigns.get", err);
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
            .order("day_bucket", { ascending: false })
            // Bounded: one row per campaign per day, desc — the cap trims the
            // oldest rows first (see GRADE_ROWS_CAP for the staleness tradeoff).
            .limit(GRADE_ROWS_CAP);
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
          const [skuRes, cogsRes, adMapRes, demandRes, salesRes, facetsRes, returnsRes] =
            await Promise.all([
            supabase
              .from("v_skus_flat")
              .select("*")
              .eq("shop_id", shopId)
              .order("on_hand", { ascending: false }),
            // Explicit caps: PostgREST silently truncates at 1000 rows by
            // default, which would drop sources as cost history grows.
            supabase
              .from("cogs_fact")
              .select("sku_id, source")
              .eq("shop_id", shopId)
              .limit(10000),
            supabase
              .from("ad_creative_sku_map")
              .select("sku_id, platform")
              .eq("shop_id", shopId)
              .limit(10000),
            // One row per SKU-with-sales; explicit cap per the PostgREST 1000-row
            // default-truncation convention above.
            supabase
              .from("v_sku_regional_demand")
              .select("*")
              .eq("shop_id", shopId)
              .limit(10000),
            // Trailing-30-day units + revenue per SKU (same window as velocity);
            // explicit cap per the PostgREST 1000-row default-truncation note.
            supabase
              .from("v_sku_sales_30d")
              .select("sku_id, revenue_30d_cents")
              .eq("shop_id", shopId)
              .limit(10000),
            // Product facets for inventory slicing (category=productType, vendor,
            // tags, collections); explicit cap per the PostgREST 1000-row default.
            supabase
              .from("sku_dim")
              .select("id, category, vendor, tags, collections")
              .eq("shop_id", shopId)
              .limit(10000),
            // Trailing-30-day return rate per SKU; explicit cap per the
            // PostgREST 1000-row default-truncation convention above.
            supabase
              .from("v_sku_returns_30d")
              .select("sku_id, returned_units_30d, return_rate")
              .eq("shop_id", shopId)
              .limit(10000),
          ]);
          if (skuRes.error) throw skuRes.error;
          if (cogsRes.error) throw cogsRes.error;
          if (adMapRes.error) throw adMapRes.error;
          // Demand enrichment is optional (demand: null is the no-data state) — a
          // missing/unmigrated view must not take down the whole SKU surface. Loud
          // log instead of throw (rule 12: visible, not fatal).
          if (demandRes.error) {
            console.error(
              "[skus.list] v_sku_regional_demand unavailable — serving SKUs without demand data",
              demandRes.error,
            );
          }
          // Sales enrichment is optional too — a missing/unmigrated rollup must
          // not take down the SKU surface (units/revenue stay undefined).
          if (salesRes.error) {
            console.error(
              "[skus.list] v_sku_sales_30d unavailable — serving SKUs without 30-day sales",
              salesRes.error,
            );
          }
          // Facet enrichment is optional too — a read failure must not take down
          // the SKU surface (facets stay undefined, filters just don't render).
          if (facetsRes.error) {
            console.error(
              "[skus.list] sku_dim facets unavailable — serving SKUs without slicing facets",
              facetsRes.error,
            );
          }
          // Return-rate enrichment is optional too — a missing/unmigrated view
          // must not take down the SKU surface (returns stays undefined).
          if (returnsRes.error) {
            console.error(
              "[skus.list] v_sku_returns_30d unavailable — serving SKUs without return rates",
              returnsRes.error,
            );
          }

          const sourcesBySku = new Map<string, Set<SkuSource>>();
          const addSource = (skuId: unknown, raw: unknown) => {
            if (!skuId) return;
            const src = String(raw ?? "").trim().toLowerCase();
            if (!isSkuSource(src)) return;
            const key = String(skuId);
            const set = sourcesBySku.get(key) ?? new Set<SkuSource>();
            set.add(src);
            sourcesBySku.set(key, set);
          };
          for (const r of cogsRes.data ?? []) addSource(r.sku_id, r.source);
          for (const r of adMapRes.data ?? []) addSource(r.sku_id, r.platform);

          const demandBySku = new Map<string, SkuDemandViewRow>();
          if (!demandRes.error) {
            for (const r of (demandRes.data ?? []) as unknown as SkuDemandViewRow[]) {
              demandBySku.set(String(r.sku_id), r);
            }
          }

          // sku_id → trailing-30-day revenue (cents).
          const revenueBySku = new Map<string, number>();
          if (!salesRes.error) {
            for (const r of (salesRes.data ?? []) as Array<Record<string, unknown>>) {
              revenueBySku.set(String(r.sku_id), Number(r.revenue_30d_cents ?? 0));
            }
          }
          // sku_dim.id → product facets (category surfaces as product_type).
          const facetsBySku = new Map<
            string,
            { product_type: string | null; vendor: string | null; tags: string[]; collections: string[] }
          >();
          if (!facetsRes.error) {
            for (const r of (facetsRes.data ?? []) as Array<Record<string, unknown>>) {
              facetsBySku.set(String(r.id), {
                product_type: (r.category as string | null) ?? null,
                vendor: (r.vendor as string | null) ?? null,
                tags: Array.isArray(r.tags) ? (r.tags as string[]) : [],
                collections: Array.isArray(r.collections) ? (r.collections as string[]) : [],
              });
            }
          }
          // sku_id → return rate. Skip rows with a null rate (returns but no sales
          // in the window) so the UI never shows a meaningless 0% / divide error.
          const returnsBySku = new Map<string, { returned_units_30d: number; rate: number }>();
          if (!returnsRes.error) {
            for (const r of (returnsRes.data ?? []) as Array<Record<string, unknown>>) {
              if (r.return_rate == null) continue;
              returnsBySku.set(String(r.sku_id), {
                returned_units_30d: Number(r.returned_units_30d ?? 0),
                rate: Number(r.return_rate),
              });
            }
          }

          return (skuRes.data ?? []).map((r) => {
            const set = sourcesBySku.get(String(r.id));
            const sources = set ? SKU_SOURCE_ORDER.filter((s) => set.has(s)) : [];
            const sku = rowToSku(r, sources);
            const demandRow = demandBySku.get(sku.id);
            if (demandRow) {
              sku.demand = demandFromRow(demandRow);
              sku.suggested_transfer = suggestedTransferFromRow(demandRow);
              sku.locations_detail = locationsDetailFromRow(demandRow);
            }
            const revenue30d = revenueBySku.get(sku.id);
            if (revenue30d != null) {
              sku.revenue_30d_cents = revenue30d;
            }
            const facetRow = facetsBySku.get(sku.id);
            if (facetRow) {
              sku.product_type = facetRow.product_type;
              sku.vendor = facetRow.vendor;
              sku.tags = facetRow.tags;
              sku.collections = facetRow.collections;
            }
            const returnsRow = returnsBySku.get(sku.id);
            if (returnsRow) {
              sku.returns = returnsRow;
            }
            return sku;
          });
        } catch (err) {
          rethrow("skus.list", err);
        }
      },

      // Daily on-hand trend for one SKU over the view's trailing 90-day window.
      // Sparse, oldest-first; the newest point reconciles with v_skus_flat.on_hand.
      // Service-role bypasses RLS, so .eq("shop_id") is the tenant guard.
      async history(skuId: string, _signal?: AbortSignal): Promise<SkuHistoryPoint[]> {
        try {
          const shopId = await shopIdP;
          const { data, error } = await supabase
            .from("v_sku_inventory_history")
            .select("day, on_hand")
            .eq("shop_id", shopId)
            .eq("sku_id", skuId)
            .order("day", { ascending: true })
            // ≤90 sparse points/SKU; explicit cap per the PostgREST 1000-row default.
            .limit(400);
          if (error) throw error;
          return (data ?? []).map((r) => ({
            date: String(r.day),
            on_hand: Number(r.on_hand ?? 0),
          }));
        } catch (err) {
          rethrow("skus.history", err);
        }
      },

      // "Frequently bought with" — top co-purchased SKUs for one SKU over the
      // trailing 90 days. Per-SKU detail fetch (not on the list). Service-role
      // bypasses RLS, so .eq("shop_id") is the tenant guard.
      async affinity(skuId: string, _signal?: AbortSignal): Promise<SkuAffinityItem[]> {
        try {
          const shopId = await shopIdP;
          const { data, error } = await supabase
            .from("v_sku_affinity")
            .select("co_sku_id, co_title, co_sku, co_count, share")
            .eq("shop_id", shopId)
            .eq("sku_id", skuId)
            .order("co_count", { ascending: false })
            // The view caps at 6 rows/SKU; an explicit cap per the PostgREST
            // 1000-row default-truncation convention.
            .limit(20);
          if (error) throw error;
          return (data ?? []).map((r) => affinityFromRow(r as unknown as SkuAffinityViewRow));
        } catch (err) {
          rethrow("skus.affinity", err);
        }
      },
    },

    locations: {
      async list(_signal?: AbortSignal): Promise<ShopLocation[]> {
        try {
          const shopId = await shopIdP;
          const { data, error } = await supabase
            .from("location_dim")
            .select("external_id, name, region, active")
            .eq("shop_id", shopId)
            .order("name", { ascending: true })
            .limit(1000);
          if (error) throw error;
          return (data ?? []).map((r) => ({
            id: String(r.external_id),
            name: String(r.name ?? r.external_id),
            region: r.region == null ? null : String(r.region),
            active: Boolean(r.active),
          }));
        } catch (err) {
          rethrow("locations.list", err);
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
          // A shop that hasn't saved guardrails yet (fresh install, pre-
          // onboarding) gets the same defaults the onboarding form pre-fills
          // instead of a 404 that blanks the home + onboarding loaders.
          // Read-only: the row is created when the merchant first saves.
          if (!data) {
            return rowToGuardrails(
              {
                daily_action_budget: DEFAULT_GUARDRAILS.daily_action_budget_cents / 100,
                dollar_impact_cap_without_2fa: DEFAULT_GUARDRAILS.dollar_cap_cents / 100,
                cooldown_minutes_per_campaign: DEFAULT_GUARDRAILS.cooldown_minutes,
              },
              await dailyUsedCents(shopId),
            );
          }
          return rowToGuardrails(data, await dailyUsedCents(shopId));
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
          if (patch.business_hours) {
            const tz = patch.business_hours.tz;
            if (tz) updates.timezone = tz;
            const zone = tz ?? "America/New_York";
            updates.business_hours_start_utc = localHourToUtc(patch.business_hours.start, zone);
            updates.business_hours_end_utc = localHourToUtc(patch.business_hours.end, zone);
          }
          if (patch.business_hours_only !== undefined) {
            updates.business_hours_only = patch.business_hours_only;
          }
          if (patch.autopilot_enabled !== undefined) updates.autopilot_enabled = patch.autopilot_enabled;
          if (patch.autopilot_bypass_guardrails !== undefined) updates.autopilot_bypass_guardrails = patch.autopilot_bypass_guardrails;
          if (patch.autopilot_daily_action_cap !== undefined) updates.autopilot_daily_action_cap = patch.autopilot_daily_action_cap;
          if (patch.autopilot_min_spend_cents !== undefined) updates.autopilot_min_spend_cents = patch.autopilot_min_spend_cents;
          if (patch.autopilot_max_budget_cut_pct !== undefined) updates.autopilot_max_budget_cut_pct = patch.autopilot_max_budget_cut_pct;
          if (patch.autopilot_max_budget_increase_pct !== undefined) updates.autopilot_max_budget_increase_pct = patch.autopilot_max_budget_increase_pct;
          // null is meaningful (clear the ceiling), so test `!== undefined`.
          if (patch.autopilot_max_daily_budget_cents !== undefined) updates.autopilot_max_daily_budget_cents = patch.autopilot_max_daily_budget_cents;
          if (patch.max_price_change_pct !== undefined) updates.max_price_change_pct = patch.max_price_change_pct;
          if (patch.autopilot_max_price_change_pct !== undefined) updates.autopilot_max_price_change_pct = patch.autopilot_max_price_change_pct;
          // null is meaningful (clear the unit cap), so test `!== undefined`.
          if (patch.autopilot_max_inventory_units_per_move !== undefined) updates.autopilot_max_inventory_units_per_move = patch.autopilot_max_inventory_units_per_move;

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
          return rowToGuardrails(data, await dailyUsedCents(shopId));
        } catch (err) {
          rethrow("guardrails.update", err);
        }
      },
    },

    calibration: {
      async get(_signal?: AbortSignal): Promise<Calibration> {
        try {
          const shopId = await shopIdP;
          const { data, error } = await supabase
            .from("shops")
            .select("calibration_pct, calibration_updated_at")
            .eq("id", shopId)
            .maybeSingle();
          if (error) throw error;

          // Fast path: calibration already computed — return it directly.
          if (data?.calibration_pct != null) {
            return {
              pct: Number(data.calibration_pct),
              updated_at: (data.calibration_updated_at as string | null) ?? null,
            };
          }

          // Lazy-compute path: calibration_pct is NULL (fresh install or not yet
          // recomputed). Compute + persist so the merchant sees a real baseline
          // immediately rather than "Calibrating". This is a one-time cache fill —
          // idempotent and only fires when the value is missing. Runs inside a
          // loader (read context); that is acceptable because subsequent reads hit
          // the fast path above. skipPeerPrior avoids N+1 RPCs on first load
          // (peer baselines are empty in prod anyway at this stage).
          try {
            await recomputeShopCalibration(shopId, { sb: supabase }, { skipPeerPrior: true });
            // Re-read the freshly persisted value so returned data matches DB.
            const { data: fresh, error: freshErr } = await supabase
              .from("shops")
              .select("calibration_pct, calibration_updated_at")
              .eq("id", shopId)
              .maybeSingle();
            if (freshErr) throw freshErr;
            return {
              pct: fresh?.calibration_pct == null ? null : Number(fresh.calibration_pct),
              updated_at: (fresh?.calibration_updated_at as string | null) ?? null,
            };
          } catch (computeErr) {
            // Degrade gracefully: a compute failure shows "Calibrating" rather
            // than breaking the page loader. The nightly cron will fill the value.
            console.error(`[calibration.get] lazy recompute failed for shop ${shopId}`, computeErr);
            return { pct: null, updated_at: null };
          }
        } catch (err) {
          rethrow("calibration.get", err);
        }
      },
      // Positive calibration signal. Resolves shopId internally so call sites
      // need only the (detectorId, actionKind) pair. Never throws -- a bump
      // failure must not surface as an action failure (see approval.server.ts).
      // Pass opts.auditId whenever the approved audit row is known: it keys the
      // once-per-audit dedup so replays/double-submits never double-bump alpha.
      async recordApproval(
        detectorId: string,
        actionKind: ActionKind,
        opts?: RecordApprovalOpts,
      ): Promise<ApproveReceipt> {
        const shopId = await shopIdP;
        return _recordApproval(shopId, detectorId, actionKind, supabase, opts);
      },
      // Negative calibration signal. Never throws (pure UX bookkeeping).
      async recordRejection(
        input: RecordRejectionInput,
      ): Promise<{ reflection: string } & RejectReceipt> {
        const shopId = await shopIdP;
        return _recordRejection(shopId, input, supabase);
      },
      // Cosmetic header stat: how many (detector, action) pairs are close to
      // graduating to autopilot. Never throws (returns 0 on any read error).
      async nearGraduation(): Promise<number> {
        const shopId = await shopIdP;
        return countNearGraduation(shopId, supabase);
      },
      // Live Engine: graduated features + their autonomous money/counts + the
      // money protected this week. Never throws (returns empty on read error).
      async liveEngine(): Promise<LiveEngineSummary> {
        const shopId = await shopIdP;
        return liveEngineSummary(shopId, supabase);
      },
      // Turn a graduated feature's unattended autonomy on/off (merchant_disabled).
      async setFeatureAutonomy(
        detectorId: string,
        actionKind: ActionKind,
        enabled: boolean,
      ): Promise<{ ok: boolean }> {
        const shopId = await shopIdP;
        return _setPairAutonomy(shopId, detectorId, actionKind, enabled, supabase);
      },
      // Per-pair Beta evidence + graduation gate for the Live Engine pipeline +
      // inspector confidence breakdowns. Covers ALL pairs (a pair shows in the
      // pipeline while still being learned). Never throws (returns [] on error).
      async pairEvidence(): Promise<PairEvidence[]> {
        try {
          const shopId = await shopIdP;
          const { data, error } = await supabase
            .from("pair_calibration")
            .select(
              "detector_id, action_kind, alpha, beta, graduation_threshold, graduated, last_detection, consecutive_clean_approvals",
            )
            .eq("shop_id", shopId);
          if (error) throw error;
          return (data ?? []).map((r) => ({
            detectorId: String(r.detector_id),
            actionKind: r.action_kind as ActionKind,
            alpha: Number(r.alpha ?? 0),
            beta: Number(r.beta ?? 0),
            graduationThreshold: Number(r.graduation_threshold ?? 80),
            graduated: Boolean(r.graduated),
            // Cached learned factors so the Live Engine pipeline/inspector show
            // the SAME confidence the queue and the recompute score with.
            lastDetection: r.last_detection == null ? null : Number(r.last_detection),
            consecutiveCleanApprovals: Number(r.consecutive_clean_approvals ?? 0),
          }));
        } catch (err) {
          console.error("[calibration.pairEvidence] read failed", err);
          return [];
        }
      },
      // Return all active learned rules for this shop, with plain-language summaries.
      async learnedRules(): Promise<LearnedRule[]> {
        try {
          const shopId = await shopIdP;
          const { data, error } = await supabase
            .from("calibration_rule")
            .select("id, detector_id, action_kind, rule_kind, rule_value, created_at")
            .eq("shop_id", shopId)
            .eq("active", true)
            .order("created_at", { ascending: false });
          if (error) throw error;
          return (data ?? []).map((r) => ({
            id: String(r.id),
            detector_id: String(r.detector_id),
            action_kind: r.action_kind as ActionKind,
            rule_kind: r.rule_kind as LearnedRule["rule_kind"],
            summary: ruleSummary(r as { detector_id: string; action_kind: ActionKind; rule_kind: string; rule_value: unknown }),
            created_at: String(r.created_at),
          }));
        } catch (err) {
          rethrow("calibration.learnedRules", err);
        }
      },
      // Deactivate a specific rule by id (scoped to this shop for safety).
      // "Hand it back any time from Learned rules" (spec §5): undoing a
      // muted_pair must ALSO clear pair_calibration.merchant_disabled — the
      // i_handle_this RPC set both, and graduationVerdict blocks on the flag,
      // so flipping only the rule would leave the pair muted forever.
      //
      // Ordering + duplicates (no transaction available through PostgREST):
      //  - Only an ACTIVE rule may be undone: a stale tab re-undoing an
      //    already-inactive rule must not clear a mute a NEWER i_handle_this
      //    just set.
      //  - The unmute runs only when NO OTHER active muted_pair rule remains
      //    for the pair (duplicates are possible under concurrent rejects).
      //  - The unmute runs BEFORE deactivating the rule: if the second write
      //    fails, the rule is still active and visible, so the merchant can
      //    simply retry — never the invisible-permanent-mute dead end.
      async undoRule(ruleId: string): Promise<void> {
        try {
          const shopId = await shopIdP;
          const { data: rule, error: readErr } = await supabase
            .from("calibration_rule")
            .select("id, detector_id, action_kind, rule_kind")
            .eq("id", ruleId)
            .eq("shop_id", shopId)
            .eq("active", true)
            .maybeSingle();
          if (readErr) throw readErr;
          if (!rule) {
            throw new CalderynError({
              code: "RULE_NOT_FOUND",
              status: 404,
              message: "That rule no longer exists.",
            });
          }
          if (rule.rule_kind === "muted_pair") {
            const { data: siblings, error: sibErr } = await supabase
              .from("calibration_rule")
              .select("id")
              .eq("shop_id", shopId)
              .eq("detector_id", rule.detector_id)
              .eq("action_kind", rule.action_kind)
              .eq("rule_kind", "muted_pair")
              .eq("active", true)
              .neq("id", ruleId)
              .limit(1);
            if (sibErr) throw sibErr;
            if ((siblings ?? []).length === 0) {
              const { error: unmuteErr } = await supabase
                .from("pair_calibration")
                .update({ merchant_disabled: false, updated_at: new Date().toISOString() })
                .eq("shop_id", shopId)
                .eq("detector_id", rule.detector_id)
                .eq("action_kind", rule.action_kind);
              if (unmuteErr) throw unmuteErr;
            }
          }
          const { error } = await supabase
            .from("calibration_rule")
            .update({ active: false })
            .eq("id", ruleId)
            .eq("shop_id", shopId);
          if (error) throw error;
        } catch (err) {
          rethrow("calibration.undoRule", err);
        }
      },
    },

    queue: {
      /**
       * Return the current action queue: open alerts that have a real recommended
       * action, ranked by claude_rank and scored with calibrated confidence.
       * peerP50 = null in this slice (no RPC call; peer baselines land in Slice 3).
       *
       * Filters applied before building proposals:
       *  - rejectedAlertIds: alerts the merchant already said no to (action_feedback decision='reject')
       *  - mutedPairs: (detector, action) pairs the merchant has muted via a calibration_rule
       */
      async list(_signal?: AbortSignal): Promise<QueueProposal[]> {
        try {
          const shopId = await shopIdP;
          // Reuse fetchOpenAlerts (same query alerts.list({status:"open"}) runs)
          // so the open-alerts SQL is not duplicated.
          const [alerts, pairsRes, feedbackRes, rulesRes, autonomyRes, gcRes] = await Promise.all([
            fetchOpenAlerts(shopId),
            supabase
              .from("pair_calibration")
              .select("detector_id, action_kind, alpha, beta, last_detection, consecutive_clean_approvals")
              .eq("shop_id", shopId),
            // Alerts the merchant explicitly rejected — exclude from queue so
            // they don't keep resurfacing after a thumbs-down.
            supabase
              .from("action_feedback")
              .select("alert_id")
              .eq("shop_id", shopId)
              .eq("decision", "reject")
              .not("alert_id", "is", null),
            // Active muted-pair rules — suppress a (detector, action) pair the
            // merchant has trained Calderyn to leave to them.
            supabase
              .from("calibration_rule")
              .select("detector_id, action_kind")
              .eq("shop_id", shopId)
              .eq("active", true)
              .eq("rule_kind", "muted_pair"),
            // I5 / Slice C: pairs RUNNING autonomously = graduated AND merchant-
            // enabled. Only these are excluded from the queue (no double actor).
            // A graduated-but-not-enabled pair stays as a suggestion so the merchant
            // can build a track record before opting it into autopilot (warm-up).
            supabase
              .from("pair_calibration")
              .select("detector_id, action_kind")
              .eq("shop_id", shopId)
              .eq("graduated", true)
              .eq("autonomy_enabled", true),
            // Autonomy unit cap for the magnitude-aware over-cap check: a graduated
            // reallocate_inventory move bigger than this is blocked by autopilot
            // (block-not-clamp), so it must stay approvable in the queue.
            supabase
              .from("guardrail_config")
              .select("autopilot_max_inventory_units_per_move")
              .eq("shop_id", shopId)
              .maybeSingle(),
          ]);

          if (pairsRes.error) throw pairsRes.error;
          if (feedbackRes.error) throw feedbackRes.error;
          if (rulesRes.error) throw rulesRes.error;
          if (autonomyRes.error) throw autonomyRes.error;
          if (gcRes.error) throw gcRes.error;

          const map = new Map(
            (pairsRes.data ?? []).map((r) => [
              `${r.detector_id}:${r.action_kind}`,
              {
                alpha: Number(r.alpha),
                beta: Number(r.beta),
                // Cached learned factors (written by the recompute) so the
                // queue's confidence matches the recompute exactly.
                lastDetection: r.last_detection == null ? null : Number(r.last_detection),
                consecutiveCleanApprovals: Number(r.consecutive_clean_approvals ?? 0),
              },
            ]),
          );

          const rejectedAlertIds = new Set(
            (feedbackRes.data ?? [])
              .map((r) => r.alert_id as string | null)
              .filter((id): id is string => id !== null),
          );

          const mutedPairs = new Set(
            (rulesRes.data ?? []).map((r) => `${r.detector_id}:${r.action_kind}`),
          );

          const autonomyPairs = new Set(
            (autonomyRes.data ?? []).map((r) => `${r.detector_id}:${r.action_kind}`),
          );

          // Magnitude-aware: keep a running reallocate_inventory alert in the queue
          // when its move exceeds the merchant's per-move unit cap (autopilot blocks
          // it, so it needs manual approval). Exact from the alert evidence.
          const maxUnitsPerMove =
            (gcRes.data as { autopilot_max_inventory_units_per_move?: number | null } | null)
              ?.autopilot_max_inventory_units_per_move ?? null;
          const overCapAlertIds = inventoryOverCapAlertIds(alerts, autonomyPairs, maxUnitsPerMove);

          return buildActionQueue(
            alerts,
            map,
            rejectedAlertIds,
            mutedPairs,
            autonomyPairs,
            overCapAlertIds,
          );
        } catch (err) {
          rethrow("queue.list", err);
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
            // Ship-cost connector (API-key paste, contract C8). Single source both
            // surfaces read; the dashboard renders it read-only via adaptIntegrations.
            easypost_ship: { name: "EasyPost", status: "disconnected", detail: "Not connected", logoCls: "logo-easypost" },
            // Ship-cost connector #2 (Shippo, co-branded OAuth, contract C8). Same
            // single source both surfaces read; dashboard renders it read-only.
            shippo_ship: { name: "Shippo", status: "disconnected", detail: "Not connected", logoCls: "logo-shippo" },
            // 3PL houses (Phase 3 Part B): ShipBob (PAT paste) + ShipHero (refresh-token
            // paste). Same single-source/read-only-dashboard treatment as EasyPost.
            shipbob_ship: { name: "ShipBob", status: "disconnected", detail: "Not connected", logoCls: "logo-shipbob" },
            shiphero_ship: { name: "ShipHero", status: "disconnected", detail: "Not connected", logoCls: "logo-shiphero" },
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
                  : r.sync_status === "reauth"
                    ? "reauth"
                    : "disconnected";
            out[kind] = {
              name: INTEGRATION_DISPLAY_NAME[kind] ?? kind,
              status,
              // An errored integration shows a plain-language reason, not the raw
              // provider/API string (which still lives in sync_error for
              // diagnosis). reauth keeps its dedicated reconnect prompt;
              // friendlyIntegrationError returns null when there's no error, so a
              // healthy row falls through to the account id / connected date.
              detail:
                status === "reauth"
                  ? "Connection expired — reconnect to resume syncing"
                  : (friendlyIntegrationError(r.sync_error) ??
                    r.external_account_id ??
                    (r.connected_at ? `Connected ${r.connected_at}` : "Pending")),
              logoCls: INTEGRATION_LOGO_CLS[kind] ?? "logo-default",
            };
          }
          return out;
        } catch (err) {
          rethrow("integrations.list", err);
        }
      },
      async startOAuth(
        provider: IntegrationProvider,
        host?: string | null,
        // popup=true (onboarding new-tab connect) makes the provider callback land
        // on the standalone /auth/connected page instead of an embedded deep link.
        popup?: boolean,
        // dashboard=true (dashboard-native connect) makes the callback land back
        // on /dashboard?<provider>=connected|error instead of the embedded admin.
        dashboard?: boolean,
      ): Promise<{ redirectUrl: string }> {
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
          const state = await createOAuthState(supabase, shopId, { host, shop, popup, dashboard });
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
          const state = await createOAuthState(supabase, shopId, { host, shop, popup, dashboard });
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
          const state = await createOAuthState(supabase, shopId, { host, shop, popup, dashboard });
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
          const state = await createOAuthState(supabase, shopId, { host, shop, popup, dashboard });
          return { redirectUrl: buildQuickbooksAuthUrl({ clientId, redirectUri, state }) };
        }
        if (provider === "shippo") {
          // Ship-cost connector #2 (Plan 02 §5.1). Co-branded OAuth — the merchant
          // owns the Shippo account + billing. client_id/secret + redirect_uri require
          // Shippo partner-program approval (HARD GATE, Plan 02 §3.2/§11).
          const clientId = process.env.SHIPPO_CLIENT_ID;
          const clientSecret = process.env.SHIPPO_CLIENT_SECRET;
          const appUrl = process.env.SHOPIFY_APP_URL;
          if (!clientId || !clientSecret || !appUrl) {
            throw new CalderynError({
              code: "SHIPPO_NOT_CONFIGURED",
              status: 500,
              message:
                "Shippo OAuth is not configured (SHIPPO_CLIENT_ID/SHIPPO_CLIENT_SECRET/SHOPIFY_APP_URL).",
            });
          }
          const redirectUri = `${appUrl}/auth/shippo`;
          // Same single-use nonce pattern as Meta/Google; consumed once at /auth/shippo.
          const shopId = await shopIdP;
          const state = await createOAuthState(supabase, shopId, { host, shop, popup, dashboard });
          return { redirectUrl: buildShippoAuthUrl({ clientId, redirectUri, state }) };
        }
        // NOTE: ShipHero is intentionally NOT handled here. It is credential/token-based
        // (the merchant pastes a REFRESH token), not OAuth — it connects via connectApiKey
        // below, the same paste path as EasyPost/ShipBob. It is no longer in OAUTH_PROVIDERS,
        // so the settings card never routes it to startOAuth.
        throw new CalderynError({
          code: "OAUTH_NOT_WIRED",
          status: 501,
          message: `${provider} OAuth is not yet wired.`,
        });
      },
      /**
       * Connect an API-key provider (EasyPost ship-cost connector, contract C8).
       * Unlike startOAuth there is NO redirect round-trip: the merchant pastes a key
       * into the embedded settings form, this validates + live-probes it, then stores
       * it ENCRYPTED in integration_credentials (kind 'easypost_ship',
       * access_token_encrypted) — NOT the legacy shop_integrations.access_token_enc
       * bytea — and upserts shop_integrations at sync_status='ready' so the cron
       * (shipAdaptersForShops) picks the shop up on its next tick. Mirrors the
       * credential-write half of auth.quickbooks.$.tsx:71-98. `fetchImpl` is injectable
       * for tests (defaults to global fetch). Returns the kind the credential landed under.
       */
      async connectApiKey(
        provider: IntegrationProvider,
        apiKey: string,
        fetchImpl: typeof fetch = fetch,
      ): Promise<{ kind: string }> {
        try {
          // API-key (paste) providers (contract C8): EasyPost (Phase 1) + ShipBob (Phase 3
          // PAT) + ShipHero (Phase 3, credential/refresh-token paste). Reject anything else
          // here rather than silently writing a credential under an unknown kind. The probe +
          // kind are provider-driven so each lands under its own kind with its own live
          // validation. NOTE on ShipHero: the pasted value is the merchant's long-lived
          // REFRESH token (stored encrypted, like the QuickBooks refresh-token model); the
          // cost adapter mints a short-lived access token from it each run.
          const APIKEY_KIND: Partial<Record<IntegrationProvider, string>> = {
            easypost: "easypost_ship",
            shipbob: "shipbob_ship",
            shiphero: "shiphero_ship",
          };
          const kind = APIKEY_KIND[provider];
          if (!kind) {
            throw new CalderynError({
              code: "NOT_APIKEY_PROVIDER",
              status: 400,
              message: `${provider} does not use API-key connect.`,
            });
          }
          const key = apiKey.trim();
          if (!key) {
            const emptyMsg =
              provider === "shipbob"
                ? "Paste your ShipBob token."
                : provider === "shiphero"
                  ? "Paste your ShipHero refresh token."
                  : "Paste your EasyPost API key.";
            throw new CalderynError({ code: "EMPTY_API_KEY", status: 400, message: emptyMsg });
          }
          // Fail visibly on a bad key/token BEFORE writing anything (rule 12).
          if (provider === "shipbob") {
            await probeShipBobKey(key, fetchImpl);
          } else if (provider === "shiphero") {
            await probeShipHeroToken(key, fetchImpl);
          } else {
            await probeEasyPostKey(key, fetchImpl);
          }

          const shopId = await shopIdP;
          const now = new Date().toISOString();

          const cred = await supabase.from("integration_credentials").upsert(
            {
              shop_id: shopId,
              kind,
              access_token_encrypted: encrypt(key),
              updated_at: now,
            },
            { onConflict: "shop_id,kind" },
          );
          if (cred.error) throw cred.error;

          const integ = await supabase.from("shop_integrations").upsert(
            {
              shop_id: shopId,
              kind,
              sync_status: "ready",
              // Clear any stale failure from a prior errored sync so Settings doesn't
              // keep showing it for this fresh pairing (mirrors the OAuth callbacks).
              sync_error: null,
              connected_at: now,
              updated_at: now,
            },
            { onConflict: "shop_id,kind" },
          );
          if (integ.error) throw integ.error;

          return { kind };
        } catch (err) {
          rethrow("integrations.connectApiKey", err);
        }
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
                  : provider === "easypost"
                    ? "easypost_ship"
                    : provider === "shippo"
                      ? "shippo_ship"
                      : provider === "shipbob"
                        ? "shipbob_ship"
                        : provider === "shiphero"
                          ? "shiphero_ship"
                          : provider;
          const { error } = await supabase
            .from("shop_integrations")
            .delete()
            .eq("shop_id", shopId)
            .eq("kind", kind);
          if (error) throw error;
          // Every credential-bearing connector stores its token in integration_credentials:
          // ship-cost providers (EasyPost/ShipBob = pasted key; ShipHero = pasted refresh
          // token; Shippo = non-expiring co-branded OAuth token) and the ad/QuickBooks
          // connectors (meta_ads/google_ads/tiktok_ads/quickbooks all upsert their encrypted
          // OAuth token into integration_credentials.access_token_encrypted). Disconnect must
          // delete that credential so no valid token is left encrypted-at-rest — Google's
          // refresh token never expires and Meta/QBO/TikTok tokens stay valid for weeks to
          // months. The delete is keyed on (shop_id, kind); a provider with no credential row
          // simply matches zero rows. Surface a failure here rather than leaving an orphaned
          // credential silently behind (rule 12).
          const { error: credErr } = await supabase
            .from("integration_credentials")
            .delete()
            .eq("shop_id", shopId)
            .eq("kind", kind);
          if (credErr) throw credErr;
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

    // Peer-baseline consent (shops.peer_data_consent). Opt-in: the column
    // defaults to false, and the engine's moat emitter only contributes a shop's
    // metrics when this is true. The onboarding consent step and the Settings
    // toggle both flow through here so the displayed state always matches what
    // the engine actually reads.
    consent: {
      async get(_signal?: AbortSignal): Promise<boolean> {
        try {
          const shopId = await shopIdP;
          const { data, error } = await supabase
            .from("shops")
            .select("peer_data_consent")
            .eq("id", shopId)
            .single();
          if (error) throw error;
          return Boolean(data.peer_data_consent);
        } catch (err) {
          rethrow("consent.get", err);
        }
      },
      async set(value: boolean, _signal?: AbortSignal): Promise<void> {
        try {
          const shopId = await shopIdP;
          const { error } = await supabase
            .from("shops")
            .update({ peer_data_consent: value, updated_at: new Date().toISOString() })
            .eq("id", shopId);
          if (error) throw error;
        } catch (err) {
          rethrow("consent.set", err);
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
          const { error } = await supabase.from("raw_shopify_webhook").insert({
            shop_id: shopId,
            topic,
            webhook_id: headers["X-Shopify-Webhook-Id"] ?? `${topic}-${Date.now()}-${newIdempotencyKey()}`,
            hmac_verified: true,
            payload: payload as object,
          });
          // 23505 = unique(webhook_id): Shopify redelivered something that
          // already landed — the delivery IS persisted, so that's success.
          if (error && error.code !== "23505") throw error;
        } catch (err) {
          rethrow("internal.forwardWebhook", err);
        }
      },
    },
  };
}

export type CalderynClient = ReturnType<typeof calderynClient>;

export { newIdempotencyKey } from "./ids";
