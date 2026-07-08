// app/routes/dashboard.api.search.tsx
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import { getSeoSettings, upsertSeoSettings } from "~/lib/seo/seo-store.server";
import { getStoreSettings } from "~/lib/storefront/settings.server";
import { getCatalog } from "~/lib/storefront/catalog.server";
import { getShopStorefrontOrigin } from "~/lib/storefront/shop.server";
import { buildStoreDescription } from "~/lib/seo/writer.server";
import { shopRegionCondition } from "~/lib/weather/shop-region.server";

// The Preferences screen (see Search.tsx) exposes the controls a merchant has —
// search-engine access, AI-assistant access, weather-aware ordering, a store
// description, and the "Get found on Google" helper. The loader hands back this
// shop's SEO settings plus its live sitemap URL (null until the shop has a
// storefront slug) and its current weather status (null when unresolvable).
export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request); // auth gate; settings are this shop's own data
  return dashboardJson(async () => {
    const [settings, origin, weatherStatus] = await Promise.all([
      getSeoSettings(session.shopId),
      getShopStorefrontOrigin(session.shopId),
      shopRegionCondition(session.shopId),
    ]);
    return { settings, sitemapUrl: origin ? `${origin}/sitemap.xml` : null, weatherStatus };
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

// Accept whatever a merchant copies from Google Search Console — the full
// <meta name="google-site-verification" content="TOKEN" /> tag, a bare
// content="TOKEN" attribute, or just the token itself — and return the clean
// token. Without this, pasting the whole tag would nest a tag inside the emitted
// tag's content attribute, producing malformed HTML that fails Google's check.
function extractVerificationToken(raw: string): string {
  const s = raw.trim();
  const m = s.match(/content\s*=\s*["']([^"']+)["']/i);
  return (m ? m[1] : s).trim();
}

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
        // Extract the bare token from whatever was pasted (full tag, attribute, or
        // token); an empty result normalizes to null so clearing the field removes
        // the meta tag rather than emitting an empty content="".
        const token = typeof body.googleSiteVerification === "string"
          ? extractVerificationToken(body.googleSiteVerification)
          : null;
        if (token && token.length > GOOGLE_TOKEN_MAX) {
          return jsonError(422, "bad_request", `verification code must be ${GOOGLE_TOKEN_MAX} characters or fewer`);
        }
        patch.googleSiteVerification = token || null;
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
    default:
      return jsonError(422, "bad_request", `unknown action: ${body.action}`);
  }
}
