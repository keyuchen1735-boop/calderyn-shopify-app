// Per-shop nightly collection: roll storefront_event up into radar_traffic_daily
// (server-side RPC - PostgREST clamps row reads at 1000) and assemble the
// bounded inputs the detectors consume. Rankings/AEO data comes from the seo
// subsystem's tables; nothing is duplicated here.
import { getSupabase } from "~/lib/supabase.server";
import { isUuid } from "~/lib/ids";
import { getCatalog } from "~/lib/storefront/catalog.server";
import { getStoreSettings } from "~/lib/storefront/settings.server";
import { getShopStorefrontOrigin } from "~/lib/storefront/shop.server";
import { getSeoSettings } from "~/lib/seo/seo-store.server";
import { buildProductDraft } from "~/lib/seo/writer.server";
import { validateDraft } from "~/lib/seo/validator.server";
import { readStorefrontReleaseState, type StorefrontReleaseState } from "~/lib/storefront-bundle/build.server";
import { parseStorefrontPath } from "./detect.server";
import type { AiCrawlDay, JsonLdCheckedPage, RadarCollectInputs, RankingSeries, TrafficDay, TrafficPath } from "./types";

export const ROLLUP_DAYS = 10;
export const TRAFFIC_WINDOW_DAYS = 35; // bounded: at most 35 rows per shop
export const CRAWL_WINDOW_DAYS = 28; // bounded: <= 28 days x 13 known bots
export const JSONLD_CHECK_MAX_PAGES = 10;

const DAY_MS = 86_400_000;

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
}

export async function collectShop(shopId: string): Promise<void> {
  if (!isUuid(shopId)) return; // demo/fixture tenants have no rows
  const sb = getSupabase();
  const { error } = await sb.rpc("radar_rollup_traffic", { p_shop: shopId, p_days: ROLLUP_DAYS });
  if (error) throw new Error(`radar_rollup_traffic: ${error.message}`);
  const stamp = await sb.from("radar_state").upsert(
    { shop_id: shopId, last_collected_at: new Date().toISOString(), updated_at: new Date().toISOString() },
    { onConflict: "shop_id" },
  );
  if (stamp.error) throw new Error(`radar_state stamp: ${stamp.error.message}`);
}

function mapTraffic(rows: Array<Record<string, unknown>>): TrafficDay[] {
  return rows.map((r) => ({
    day: String(r.day),
    views: Number(r.views ?? 0),
    sessions: Number(r.sessions ?? 0),
    cartAdds: Number(r.cart_adds ?? 0),
    checkouts: Number(r.checkouts ?? 0),
    topPaths: Array.isArray(r.top_paths)
      ? (r.top_paths as Array<Record<string, unknown>>).map((p): TrafficPath => ({
          path: String(p.path ?? ""),
          views: Number(p.views ?? 0),
          cartAdds: Number(p.cartAdds ?? 0),
          productId: p.productId == null ? null : String(p.productId),
        }))
      : [],
  }));
}

/** Last time either storefront runtime published. Legacy uses the home
 *  page_document's updated_at (drafts also bump it - an acceptable staleness
 *  proxy that only ever UNDER-reports staleness, never over). */
async function lastPublishedAt(shopId: string, release: StorefrontReleaseState): Promise<string | null> {
  const sb = getSupabase();
  if (release.publishedRuntimeVersion === 1 && release.publishedVersionId) {
    const { data, error } = await sb
      .from("storefront_bundle_version")
      .select("created_at")
      .eq("shop_id", shopId)
      .eq("id", release.publishedVersionId)
      .maybeSingle();
    if (error) throw new Error(`bundle version read: ${error.message}`);
    return data ? String(data.created_at) : null;
  }
  const { data, error } = await sb
    .from("page_document")
    .select("updated_at, published_json")
    .eq("shop_id", shopId)
    .eq("page_key", "home")
    .maybeSingle();
  if (error) throw new Error(`page_document read: ${error.message}`);
  return data?.published_json ? String(data.updated_at) : null;
}

/** Run the REAL seo writer + validator over the shop's most-viewed products so
 *  jsonld moves only ever report what the storefront would actually serve. */
async function checkTopProductJsonLd(shopId: string, traffic: TrafficDay[]): Promise<JsonLdCheckedPage[]> {
  const origin = await getShopStorefrontOrigin(shopId);
  if (!origin) return [];
  const views = new Map<string, number>();
  for (const d of traffic.slice(-7)) {
    for (const p of d.topPaths) {
      const ref = parseStorefrontPath(p.path);
      if (ref.entityType === "product" && ref.handle) {
        views.set(ref.handle, (views.get(ref.handle) ?? 0) + p.views);
      }
    }
  }
  const handles = [...views.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, JSONLD_CHECK_MAX_PAGES)
    .map(([handle]) => handle);
  if (handles.length === 0) return [];
  const store = await getStoreSettings(shopId);
  const productPromises = handles.map(handle =>
    getCatalog().getProduct(shopId, handle).then(product => ({ product, handle }))
  );
  const results = await Promise.all(productPromises);
  return results
    .filter(({ product }) => product !== null)
    .map(({ product, handle }) => {
      const draft = buildProductDraft(product!, store, origin);
      const issues = validateDraft(draft)
        .filter((i) => i.field === "jsonLd")
        .map((i) => i.message);
      return { productId: product!.id, handle, title: product!.title || handle, issues };
    });
}

export async function loadRadarInputs(shopId: string): Promise<RadarCollectInputs> {
  if (!isUuid(shopId)) {
    return {
      traffic: [],
      rankings: [],
      aiCrawl: [],
      allowAiCrawlers: false,
      hasOrgDescription: false,
      lastPublishedAt: null,
      jsonLdIssues: [],
      publishedRuntimeVersion: null,
    };
  }
  // radar_rollup_traffic (collectShop) writes a row for the CURRENT UTC day at
  // cron time - at most a few hours of data, never a complete day. Excluding
  // it here, at the single read boundary every detector's inputs pass
  // through, is what stops a partial "today" from ever being read as a
  // complete "yesterday" downstream (guaranteed false traffic-drop moves
  // otherwise). `today` is computed once and reused for both the query filter
  // and the belt-and-suspenders in-memory filter below.
  const today = isoDaysAgo(0);
  const sb = getSupabase();
  const [trafficRes, seriesRes, crawlRes, seo, release] = await Promise.all([
    sb.from("radar_traffic_daily")
      .select("day, views, sessions, cart_adds, checkouts, top_paths")
      .eq("shop_id", shopId)
      .gte("day", isoDaysAgo(TRAFFIC_WINDOW_DAYS))
      .lt("day", today)
      .order("day"),
    sb.rpc("read_radar_ranking_series", { p_shop: shopId }),
    sb.from("seo_ai_crawl_daily")
      .select("bot_name, day, hits")
      .eq("shop_id", shopId)
      .gte("day", isoDaysAgo(CRAWL_WINDOW_DAYS)),
    getSeoSettings(shopId),
    readStorefrontReleaseState(shopId),
  ]);
  if (trafficRes.error) throw new Error(`radar_traffic_daily read: ${trafficRes.error.message}`);
  if (seriesRes.error) throw new Error(`read_radar_ranking_series: ${seriesRes.error.message}`);
  if (crawlRes.error) throw new Error(`seo_ai_crawl_daily read: ${crawlRes.error.message}`);

  // The query above already excludes today; filter again in-memory so this
  // boundary is correct even if the query changes later or a test/mocked
  // client bypasses the `.lt` filter.
  const traffic = mapTraffic((trafficRes.data ?? []) as Array<Record<string, unknown>>)
    .filter((d) => d.day < today);
  const rankings = (Array.isArray(seriesRes.data) ? seriesRes.data : []) as RankingSeries[];
  const aiCrawl: AiCrawlDay[] = ((crawlRes.data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    botName: String(r.bot_name),
    day: String(r.day),
    hits: Number(r.hits ?? 0),
  }));
  const [publishedAt, jsonLdIssues] = await Promise.all([
    lastPublishedAt(shopId, release),
    checkTopProductJsonLd(shopId, traffic),
  ]);
  return {
    traffic,
    rankings,
    aiCrawl,
    allowAiCrawlers: seo.allowAiCrawlers,
    hasOrgDescription: Boolean(seo.orgDescription?.trim()),
    lastPublishedAt: publishedAt,
    jsonLdIssues,
    publishedRuntimeVersion: release.publishedRuntimeVersion,
  };
}
