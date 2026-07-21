// app/routes/dashboard.api.search.tsx
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import { getSeoSettings, upsertSeoSettings, cleanGoogleToken } from "~/lib/seo/seo-store.server";
import { getStoreSettings } from "~/lib/storefront/settings.server";
import { getCatalog } from "~/lib/storefront/catalog.server";
import { getShopStorefrontOrigin } from "~/lib/storefront/shop.server";
import { buildStoreDescription } from "~/lib/seo/writer.server";
import { getSupabase } from "~/lib/supabase.server";
import { disconnectGsc } from "~/lib/seo/gsc.server";

// Browser-safe mirror lives in app/lib/dashboard/search-client.ts (SearchGoogleVM) —
// keep the two in sync by hand, same convention as SeoSettings above.
interface GoogleQueryRow {
  query: string;
  clicks: number;
  position: number;
}
interface GoogleSlipRow {
  pageUrl: string;
  query: string;
  position: number;
  prevPosition: number;
}
interface GoogleBlock {
  connected: boolean;
  siteUrl: string | null;
  clicks: number;
  impressions: number;
  topQueries: GoogleQueryRow[];
  slipping: GoogleSlipRow[];
  lastCapturedDate: string | null;
}

const EMPTY_GOOGLE_STATS = {
  clicks: 0,
  impressions: 0,
  topQueries: [] as GoogleQueryRow[],
  slipping: [] as GoogleSlipRow[],
  lastCapturedDate: null as string | null,
};

// The Google card's read: connection state comes straight off seo_settings
// (getSeoSettings doesn't expose the gsc_* columns), then — only when
// connected — the 28-day rankings summary RPC. The RPC is best-effort: a
// failure there must never take down the rest of the Search screen, so it's
// caught and logged, leaving the card to show zeros with a "delayed" note
// rather than an error state.
async function getGoogleBlock(shopId: string): Promise<GoogleBlock> {
  const { data: row, error: rowError } = await getSupabase()
    .from("seo_settings")
    .select("gsc_connected, gsc_site_url")
    .eq("shop_id", shopId)
    .maybeSingle();
  if (rowError) {
    console.error("[search] gsc connection state read failed", rowError);
    return { connected: false, siteUrl: null, ...EMPTY_GOOGLE_STATS };
  }
  const connected = Boolean((row as { gsc_connected?: boolean } | null)?.gsc_connected);
  const siteUrl = ((row as { gsc_site_url?: string | null } | null)?.gsc_site_url) ?? null;
  if (!connected) return { connected: false, siteUrl, ...EMPTY_GOOGLE_STATS };

  try {
    const { data, error } = await getSupabase().rpc("read_seo_rankings_summary", { p_shop: shopId });
    if (error) throw new Error(error.message);
    const s = (data ?? {}) as Partial<Omit<GoogleBlock, "connected" | "siteUrl">>;
    return {
      connected: true,
      siteUrl,
      clicks: s.clicks ?? 0,
      impressions: s.impressions ?? 0,
      topQueries: s.topQueries ?? [],
      slipping: s.slipping ?? [],
      lastCapturedDate: s.lastCapturedDate ?? null,
    };
  } catch (err) {
    console.error("[search] rankings summary failed", err);
    return { connected: true, siteUrl, ...EMPTY_GOOGLE_STATS };
  }
}

// The Preferences screen (see Search.tsx) exposes the controls a merchant has —
// search-engine access, AI-assistant access, weather-aware ordering, a store
// description, and the "Get found on Google" helper. The loader hands back this
// shop's SEO settings plus its live sitemap URL (null until the shop has a
// storefront slug). Weather-aware ordering is resolved per-visitor at serve
// time, so there is no shop-level weather status to return here.
export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request); // auth gate; settings are this shop's own data
  return dashboardJson(async () => {
    const [settings, origin, google] = await Promise.all([
      getSeoSettings(session.shopId),
      getShopStorefrontOrigin(session.shopId),
      getGoogleBlock(session.shopId),
    ]);
    return { settings, sitemapUrl: origin ? `${origin}/sitemap.xml` : null, google };
  });
}

interface SearchBody {
  action?: string;
  allowSearchEngines?: boolean;
  allowAiCrawlers?: boolean;
  weatherMerchandising?: boolean;
  orgName?: string | null;
  orgDescription?: string | null;
  googleSiteVerification?: string | null;
}

// Store-identity bounds. Clamp at the boundary so a crafted request can't persist
// an unbounded value into seo_settings. The Google token is short (~40-100 chars);
// 200 is generous headroom without being unbounded.
const ORG_NAME_MAX = 80;
const ORG_DESC_MAX = 200;
const GOOGLE_TOKEN_MAX = 200;

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request); // throws a 403 Response on a cross-origin post
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");

  const body = (await request.json().catch(() => null)) as SearchBody | null;
  if (!body || typeof body.action !== "string") return jsonError(422, "bad_request", "action is required");

  switch (body.action) {
    case "updateSettings": {
      const patch: Record<string, unknown> = {};
      if (typeof body.allowSearchEngines === "boolean") patch.allowSearchEngines = body.allowSearchEngines;
      if (typeof body.allowAiCrawlers === "boolean") patch.allowAiCrawlers = body.allowAiCrawlers;
      if (typeof body.weatherMerchandising === "boolean") patch.weatherMerchandising = body.weatherMerchandising;
      if (body.orgName === null || typeof body.orgName === "string") {
        if (typeof body.orgName === "string" && body.orgName.length > ORG_NAME_MAX) {
          return jsonError(422, "bad_request", `store name must be ${ORG_NAME_MAX} characters or fewer`);
        }
        patch.orgName = body.orgName;
      }
      if (body.orgDescription === null || typeof body.orgDescription === "string") {
        if (typeof body.orgDescription === "string" && body.orgDescription.length > ORG_DESC_MAX) {
          return jsonError(422, "bad_request", `description must be ${ORG_DESC_MAX} characters or fewer`);
        }
        patch.orgDescription = body.orgDescription;
      }
      if (body.googleSiteVerification === null || typeof body.googleSiteVerification === "string") {
        // Reduce whatever was pasted (full tag, content="TOKEN", or bare token) to
        // the clean token; empty normalizes to null so clearing removes the tag.
        const token = cleanGoogleToken(body.googleSiteVerification);
        if (token && token.length > GOOGLE_TOKEN_MAX) {
          return jsonError(422, "bad_request", `verification code must be ${GOOGLE_TOKEN_MAX} characters or fewer`);
        }
        patch.googleSiteVerification = token;
      }
      if (Object.keys(patch).length === 0) return jsonError(422, "bad_request", "no settings to update");
      return dashboardJson(async () => ({ settings: await upsertSeoSettings(session.shopId, patch) }));
    }
    case "suggestDescription": {
      // Compose (never persist) a one-line store description from this shop's own
      // identity + catalog, tuned for search + AI answers. Deterministic, so it
      // works without any AI spend; the merchant reviews and saves it themselves.
      return dashboardJson(async () => {
        const [store, collections, products] = await Promise.all([
          getStoreSettings(session.shopId),
          getCatalog().listCollections(session.shopId),
          getCatalog().listProducts(session.shopId),
        ]);
        const subjects = collections.length
          ? collections.map((c) => c.title)
          : products.slice(0, 3).map((p) => p.title);
        return { description: buildStoreDescription(store, subjects) };
      });
    }
    case "gsc_disconnect": {
      return dashboardJson(async () => {
        await disconnectGsc(session.shopId);
        return { ok: true };
      });
    }
    default:
      return jsonError(422, "bad_request", `unknown action: ${body.action}`);
  }
}
