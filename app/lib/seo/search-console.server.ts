// Search Analytics pull -> seo_ranking (Radar Phase B). Idempotent daily
// upserts on (shop_id, query, page_url, captured_date). GSC data lags about
// two days, so each pull re-covers the three most recent lagged days.
import { getSupabase } from "~/lib/supabase.server";
import { loadGscRefreshToken, refreshGscAccessToken } from "./gsc.server";

const API = "https://www.googleapis.com/webmasters/v3";
const ROW_LIMIT = 1000;
const LAG_DAYS = 2;
const PULL_DAYS = 3;

export type RankingRow = {
  query: string;
  pageUrl: string;
  position: number;
  impressions: number;
  clicks: number;
  ctr: number;
};

export async function listGscSites(accessToken: string, fetcher: typeof fetch = fetch): Promise<string[]> {
  const res = await fetcher(`${API}/sites`, {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GSC sites ${res.status}: ${text}`);
  const parsed = JSON.parse(text) as { siteEntry?: Array<{ siteUrl: string }> };
  return (parsed.siteEntry ?? []).map((s) => s.siteUrl);
}

export function pickSiteForOrigin(sites: string[], origin: string): string | null {
  const host = new URL(origin).hostname;
  const prefix = sites.find((s) => {
    try {
      return !s.startsWith("sc-domain:") && new URL(s).hostname === host;
    } catch {
      return false;
    }
  });
  if (prefix) return prefix;
  const domain = sites.find((s) => {
    if (!s.startsWith("sc-domain:")) return false;
    const d = s.slice("sc-domain:".length);
    return host === d || host.endsWith(`.${d}`);
  });
  return domain ?? null;
}

export async function fetchSearchAnalytics(
  accessToken: string,
  siteUrl: string,
  day: string,
  fetcher: typeof fetch = fetch,
): Promise<RankingRow[]> {
  const res = await fetcher(`${API}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ startDate: day, endDate: day, dimensions: ["query", "page"], rowLimit: ROW_LIMIT }),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GSC searchAnalytics ${res.status}: ${text}`);
  const parsed = JSON.parse(text) as {
    rows?: Array<{ keys: [string, string]; position: number; impressions: number; clicks: number; ctr: number }>;
  };
  return (parsed.rows ?? []).map((r) => ({
    query: r.keys[0],
    pageUrl: r.keys[1],
    position: r.position,
    impressions: r.impressions,
    clicks: r.clicks,
    ctr: r.ctr,
  }));
}

export async function upsertRankings(shopId: string, day: string, rows: RankingRow[]): Promise<number> {
  if (!rows.length) return 0;
  const { error } = await getSupabase().from("seo_ranking").upsert(
    rows.map((r) => ({
      shop_id: shopId,
      query: r.query,
      page_url: r.pageUrl,
      position: r.position,
      impressions: r.impressions,
      clicks: r.clicks,
      ctr: r.ctr,
      captured_date: day,
    })),
    { onConflict: "shop_id,query,page_url,captured_date" },
  );
  if (error) throw new Error(`upsertRankings: ${error.message}`);
  return rows.length;
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function pullShopRankings(
  shopId: string,
  opts: { fetcher?: typeof fetch; today?: Date } = {},
): Promise<{ days: number; rows: number }> {
  const fetcher = opts.fetcher ?? fetch;
  const refreshToken = await loadGscRefreshToken(shopId);
  if (!refreshToken) throw new Error("gsc_not_connected");
  const { data, error } = await getSupabase()
    .from("seo_settings")
    .select("gsc_site_url")
    .eq("shop_id", shopId)
    .maybeSingle();
  if (error) throw new Error(`pullShopRankings settings: ${error.message}`);
  const siteUrl = data?.gsc_site_url;
  if (!siteUrl) throw new Error("gsc_site_not_set");
  const accessToken = await refreshGscAccessToken(refreshToken, fetcher);
  const today = opts.today ?? new Date();
  let rows = 0;
  for (let back = LAG_DAYS; back < LAG_DAYS + PULL_DAYS; back++) {
    const day = isoDay(new Date(today.getTime() - back * 86_400_000));
    rows += await upsertRankings(shopId, day, await fetchSearchAnalytics(accessToken, siteUrl, day, fetcher));
  }
  const { error: stampError } = await getSupabase()
    .from("seo_settings")
    .update({ gsc_last_pulled_at: new Date().toISOString() })
    .eq("shop_id", shopId);
  if (stampError) console.error(`[search-console] gsc_last_pulled_at stamp failed for shop ${shopId}`, stampError);
  return { days: PULL_DAYS, rows };
}
