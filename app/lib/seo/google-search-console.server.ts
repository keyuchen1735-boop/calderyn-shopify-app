// app/lib/seo/google-search-console.server.ts
// Google Search Console rankings loop. Reuses the repo's verified Google data
// OAuth client (GOOGLE_ADS_CLIENT_ID/SECRET, overridable via
// GOOGLE_SEARCH_CONSOLE_*) and adds the read-only Search Console scope. The
// merchant's refresh token is stored ENCRYPTED in seo_google_credential (a
// deny-all secret table); only this service-role module reads it. Pure helpers
// take an injected fetcher so token/analytics parsing is unit-testable offline.
import { getSupabase } from "~/lib/supabase.server";
import { encrypt, decrypt } from "~/lib/crypto.server";
import { publicBaseUrl } from "~/lib/dashboard/http.server";
import { tenantDomain } from "~/lib/storefront/vercel-domain.server";
import { isUuid } from "~/lib/ids";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GSC_API_BASE = "https://www.googleapis.com/webmasters/v3";
export const GSC_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";

const WINDOW_DAYS = 30;   // pull window; wide enough to hold slip history
const CARD_WINDOW_DAYS = 28;
const SLIP_THRESHOLD = 5; // positions a query must drop to count as slipping

export interface RankingRow {
  query: string;
  pageUrl: string;
  position: number;
  impressions: number;
  clicks: number;
  ctr: number;
  capturedDate: string;
}
export interface GscState { connected: boolean; siteUrl: string | null }
export interface GoogleCardVM {
  connected: boolean;
  clicks: number;
  impressions: number;
  topQuery: string | null;
  topPosition: number | null;
}
export interface RankingSlip { pageUrl: string; query: string; fromPosition: number; toPosition: number; delta: number }

export type GoogleTokenResponse = { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };
export type TokenFetcher = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string }) => Promise<GoogleTokenResponse>;
export interface GscAnalyticsRow { keys?: string[]; clicks?: number; impressions?: number; ctr?: number; position?: number }
export interface GscAnalyticsResponse { rows?: GscAnalyticsRow[]; error?: { message?: string } }
export type AnalyticsFetcher = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string }) => Promise<GscAnalyticsResponse>;

const ymd = (d: Date): string => d.toISOString().slice(0, 10);

// --- env gating (dormancy) -------------------------------------------------
function gscClientCreds(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.GOOGLE_SEARCH_CONSOLE_CLIENT_ID ?? process.env.GOOGLE_ADS_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_SEARCH_CONSOLE_CLIENT_SECRET ?? process.env.GOOGLE_ADS_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}
export function gscConfigured(): boolean {
  return gscClientCreds() !== null;
}
export function gscRedirectUri(): string {
  return `${publicBaseUrl()}/dashboard/auth/gsc/callback`;
}

// --- connect ---------------------------------------------------------------
export function buildConnectUrl(shopId: string, state: string): string | null {
  const creds = gscClientCreds();
  if (!creds) {
    console.warn(`[seo/gsc] connect requested for shop ${shopId} but Google OAuth is not configured`);
    return null;
  }
  const p = new URLSearchParams({
    client_id: creds.clientId,
    redirect_uri: gscRedirectUri(),
    response_type: "code",
    scope: GSC_SCOPE,
    state,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
  });
  return `${AUTH_ENDPOINT}?${p.toString()}`;
}

export async function exchangeCodeForRefreshToken(
  fetcher: TokenFetcher,
  opts: { clientId: string; clientSecret: string; redirectUri: string; code: string },
): Promise<string> {
  const body = new URLSearchParams({
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    redirect_uri: opts.redirectUri,
    code: opts.code,
    grant_type: "authorization_code",
  }).toString();
  const res = await fetcher(TOKEN_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (res.error || !res.access_token) {
    throw new Error(`Google OAuth error: ${res.error_description ?? res.error ?? "no access_token returned"}`);
  }
  if (!res.refresh_token) {
    throw new Error("Google OAuth returned no refresh_token; re-consent with access_type=offline & prompt=consent");
  }
  return res.refresh_token;
}

export async function exchangeRefreshForAccess(
  fetcher: TokenFetcher,
  opts: { clientId: string; clientSecret: string; refreshToken: string },
): Promise<string> {
  const body = new URLSearchParams({
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    refresh_token: opts.refreshToken,
    grant_type: "refresh_token",
  }).toString();
  const res = await fetcher(TOKEN_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (res.error || !res.access_token) {
    throw new Error(`Google OAuth token exchange failed (${res.error ?? "unknown"}): ${res.error_description ?? res.error ?? "no access_token"}`);
  }
  return res.access_token;
}

const realTokenFetcher: TokenFetcher = (url, init) => fetch(url, init).then((r) => r.json()) as Promise<GoogleTokenResponse>;
const realAnalyticsFetcher: AnalyticsFetcher = (url, init) => fetch(url, init).then((r) => r.json()) as Promise<GscAnalyticsResponse>;

// The Search Console property for a shop is its storefront origin (URL-prefix
// form). Resolved from shops.org_slug so we never call the overview module
// (which imports this one) and never hard-code a host.
async function siteUrlForShop(shopId: string): Promise<string> {
  const { data, error } = await getSupabase().from("shops").select("org_slug").eq("id", shopId).maybeSingle();
  if (error) throw error;
  const slug = typeof data?.org_slug === "string" ? data.org_slug.trim() : "";
  return slug ? `https://${tenantDomain(slug)}/` : "";
}

export async function exchangeAndStore(shopId: string, code: string): Promise<void> {
  const creds = gscClientCreds();
  if (!creds) throw new Error("Google OAuth is not configured");
  const refreshToken = await exchangeCodeForRefreshToken(realTokenFetcher, {
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
    redirectUri: gscRedirectUri(),
    code,
  });
  const sb = getSupabase();
  const now = new Date().toISOString();
  const { error: credErr } = await sb
    .from("seo_google_credential")
    .upsert({ shop_id: shopId, refresh_token_encrypted: encrypt(refreshToken), updated_at: now }, { onConflict: "shop_id" });
  if (credErr) throw credErr;
  const siteUrl = await siteUrlForShop(shopId);
  const { error: setErr } = await sb
    .from("seo_settings")
    .upsert({ shop_id: shopId, gsc_connected: true, gsc_site_url: siteUrl, updated_at: now }, { onConflict: "shop_id" });
  if (setErr) throw setErr;
}

export async function disconnect(shopId: string): Promise<void> {
  const sb = getSupabase();
  const { error: delErr } = await sb.from("seo_google_credential").delete().eq("shop_id", shopId);
  if (delErr) throw delErr;
  const { error: setErr } = await sb
    .from("seo_settings")
    .upsert({ shop_id: shopId, gsc_connected: false, gsc_site_url: null, updated_at: new Date().toISOString() }, { onConflict: "shop_id" });
  if (setErr) throw setErr;
}

// --- state reads -----------------------------------------------------------
export async function getGscState(shopId: string): Promise<GscState> {
  if (!isUuid(shopId)) return { connected: false, siteUrl: null };
  const { data, error } = await getSupabase().from("seo_settings").select("gsc_connected, gsc_site_url").eq("shop_id", shopId).maybeSingle();
  if (error) throw error;
  return { connected: data?.gsc_connected === true, siteUrl: (data?.gsc_site_url as string | null) ?? null };
}

export async function listConnectedShopIds(): Promise<string[]> {
  const { data, error } = await getSupabase().from("seo_settings").select("shop_id").eq("gsc_connected", true);
  if (error) throw error;
  return (data ?? []).map((r) => String((r as { shop_id: string }).shop_id));
}

// --- sync ------------------------------------------------------------------
export function parseAnalyticsRows(resp: GscAnalyticsResponse): RankingRow[] {
  if (resp.error) throw new Error(`Search Console API error: ${resp.error.message ?? "unknown"}`);
  const out: RankingRow[] = [];
  for (const r of resp.rows ?? []) {
    const keys = r.keys ?? [];
    if (keys.length < 3) continue; // dimensions = [date, query, page]
    out.push({
      capturedDate: keys[0],
      query: keys[1],
      pageUrl: keys[2],
      position: Number(r.position ?? 0),
      impressions: Number(r.impressions ?? 0),
      clicks: Number(r.clicks ?? 0),
      ctr: Number(r.ctr ?? 0),
    });
  }
  return out;
}

export async function fetchAnalyticsWith(
  fetcher: AnalyticsFetcher,
  opts: { accessToken: string; siteUrl: string; startDate: string; endDate: string },
): Promise<RankingRow[]> {
  const url = `${GSC_API_BASE}/sites/${encodeURIComponent(opts.siteUrl)}/searchAnalytics/query`;
  const resp = await fetcher(url, {
    method: "POST",
    headers: { authorization: `Bearer ${opts.accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ startDate: opts.startDate, endDate: opts.endDate, dimensions: ["date", "query", "page"], rowLimit: 1000 }),
  });
  return parseAnalyticsRows(resp);
}

export async function fetchSearchAnalytics(shopId: string): Promise<RankingRow[]> {
  const creds = gscClientCreds();
  if (!creds) return [];
  const sb = getSupabase();
  const { data: cred, error: credErr } = await sb
    .from("seo_google_credential")
    .select("refresh_token_encrypted")
    .eq("shop_id", shopId)
    .maybeSingle();
  if (credErr) throw credErr;
  const enc = (cred as { refresh_token_encrypted?: string } | null)?.refresh_token_encrypted;
  if (!enc) return [];
  const state = await getGscState(shopId);
  if (!state.siteUrl) return [];
  const refreshToken = decrypt(enc);
  const accessToken = await exchangeRefreshForAccess(realTokenFetcher, {
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
    refreshToken,
  });
  return fetchAnalyticsWith(realAnalyticsFetcher, {
    accessToken,
    siteUrl: state.siteUrl,
    startDate: ymd(new Date(Date.now() - WINDOW_DAYS * 86_400_000)),
    endDate: ymd(new Date()),
  });
}

export async function syncRankings(shopId: string): Promise<{ upserted: number }> {
  const rows = await fetchSearchAnalytics(shopId);
  if (rows.length === 0) return { upserted: 0 };
  const payload = rows.map((r) => ({
    shop_id: shopId,
    query: r.query,
    page_url: r.pageUrl,
    position: r.position,
    impressions: r.impressions,
    clicks: r.clicks,
    ctr: r.ctr,
    captured_date: r.capturedDate,
    source: "search_console",
  }));
  const { error } = await getSupabase().from("seo_ranking").upsert(payload, { onConflict: "shop_id,query,page_url,captured_date" });
  if (error) throw error;
  return { upserted: payload.length };
}

export async function getRankingsSince(shopId: string, sinceDate: string): Promise<RankingRow[]> {
  if (!isUuid(shopId)) return [];
  const { data, error } = await getSupabase()
    .from("seo_ranking")
    .select("query, page_url, position, impressions, clicks, ctr, captured_date")
    .eq("shop_id", shopId)
    .gte("captured_date", sinceDate);
  if (error) throw error;
  return (data ?? []).map((r) => {
    const row = r as Record<string, unknown>;
    return {
      query: String(row.query),
      pageUrl: String(row.page_url),
      position: Number(row.position ?? 0),
      impressions: Number(row.impressions ?? 0),
      clicks: Number(row.clicks ?? 0),
      ctr: Number(row.ctr ?? 0),
      capturedDate: String(row.captured_date),
    };
  });
}

// --- pure analyzers --------------------------------------------------------
export function summariseGoogleCard(rows: RankingRow[]): { clicks: number; impressions: number; topQuery: string | null; topPosition: number | null } {
  let clicks = 0;
  let impressions = 0;
  const byQuery = new Map<string, { clicks: number; posSum: number; n: number }>();
  for (const r of rows) {
    clicks += r.clicks;
    impressions += r.impressions;
    const q = byQuery.get(r.query) ?? { clicks: 0, posSum: 0, n: 0 };
    q.clicks += r.clicks;
    q.posSum += r.position;
    q.n += 1;
    byQuery.set(r.query, q);
  }
  let topQuery: string | null = null;
  let topClicks = -1;
  let topPosition: number | null = null;
  for (const [q, agg] of byQuery) {
    if (agg.clicks > topClicks) {
      topClicks = agg.clicks;
      topQuery = q;
      topPosition = agg.n ? Math.round((agg.posSum / agg.n) * 10) / 10 : null;
    }
  }
  return { clicks, impressions, topQuery, topPosition };
}

export function detectSlips(rows: RankingRow[], threshold = SLIP_THRESHOLD): RankingSlip[] {
  const groups = new Map<string, RankingRow[]>();
  for (const r of rows) {
    const k = `${r.pageUrl} ${r.query}`;
    const arr = groups.get(k);
    if (arr) arr.push(r);
    else groups.set(k, [r]);
  }
  const slips: RankingSlip[] = [];
  for (const g of groups.values()) {
    if (g.length < 2) continue; // need at least two captures to measure movement
    const sorted = [...g].sort((a, b) => (a.capturedDate < b.capturedDate ? -1 : a.capturedDate > b.capturedDate ? 1 : 0));
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const delta = last.position - first.position; // positive = dropped down the results
    if (delta >= threshold) {
      slips.push({ pageUrl: last.pageUrl, query: last.query, fromPosition: first.position, toPosition: last.position, delta });
    }
  }
  return slips.sort((a, b) => b.delta - a.delta);
}

export const RANKING_CARD_WINDOW_DAYS = CARD_WINDOW_DAYS;
