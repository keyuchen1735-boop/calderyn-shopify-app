// app/routes/dashboard.api.search.tsx
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import { getProductSeoDetail, getShopStorefrontOrigin } from "~/lib/seo/overview.server";
import { getSeoSettings, upsertSeoOverride, deleteSeoOverride, upsertSeoSettings } from "~/lib/seo/seo-store.server";
import { getCatalog } from "~/lib/storefront/catalog.server";
import { getSupabase } from "~/lib/supabase.server";
import { createOAuthState } from "~/lib/meta/oauth-state.server";
import { buildConnectUrl, disconnect as disconnectGsc } from "~/lib/seo/google-search-console.server";

// The Search screen is a status confirmation + settings form now (see
// Search.tsx): the loader hands back just this shop's SEO settings, not the
// full health-score/per-product overview.
export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request); // auth gate; settings are this shop's own data
  return dashboardJson(async () => ({ settings: await getSeoSettings(session.shopId) }));
}

interface SearchBody {
  action?: string;
  handle?: string;
  entityId?: string;
  metaTitle?: string;
  metaDescription?: string;
  allowAiCrawlers?: boolean;
  orgName?: string | null;
  orgDescription?: string | null;
}

// Generous bounds so a merchant is never blocked mid-edit (the engine's own
// validator uses tighter SERP limits for scoring, not gating).
const TITLE_MAX = 70;
const DESC_MAX = 200;
// Store-identity bounds. Clamp at the boundary so a crafted request can't persist
// an unbounded org name/description into seo_settings.
const ORG_NAME_MAX = 80;
const ORG_DESC_MAX = 200;

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request); // throws a 403 Response on a cross-origin post
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");

  const body = (await request.json().catch(() => null)) as SearchBody | null;
  if (!body || typeof body.action !== "string") return jsonError(422, "bad_request", "action is required");

  switch (body.action) {
    case "detail": {
      if (!body.handle) return jsonError(422, "bad_request", "handle is required");
      const handle = body.handle;
      return dashboardJson(async () =>
        getProductSeoDetail(session.shopId, handle, await getShopStorefrontOrigin(session.shopId)),
      );
    }
    case "saveOverride": {
      if (!body.entityId) return jsonError(422, "bad_request", "entityId is required");
      if (typeof body.metaTitle !== "string" || typeof body.metaDescription !== "string") {
        return jsonError(422, "bad_request", "metaTitle and metaDescription are required");
      }
      const metaTitle = body.metaTitle.trim();
      const metaDescription = body.metaDescription.trim();
      if (!metaTitle || metaTitle.length > TITLE_MAX) return jsonError(422, "bad_request", `title must be 1 to ${TITLE_MAX} characters`);
      if (!metaDescription || metaDescription.length > DESC_MAX) return jsonError(422, "bad_request", `description must be 1 to ${DESC_MAX} characters`);
      const entityId = body.entityId;
      // Confirm the entity is a real product of THIS shop before writing a seo_page
      // row: a crafted entityId must never create an override for another tenant's
      // (or a non-existent) product. Resolve against the shop-scoped catalog.
      const products = await getCatalog().listProducts(session.shopId);
      if (!products.some((p) => p.id === entityId)) return jsonError(422, "bad_request", "unknown product");
      return dashboardJson(async () => {
        await upsertSeoOverride(session.shopId, {
          entityType: "product",
          entityId,
          metaTitle,
          metaDescription,
          updatedBy: session.userId,
        });
        return { ok: true };
      });
    }
    case "resetOverride": {
      if (!body.entityId) return jsonError(422, "bad_request", "entityId is required");
      const entityId = body.entityId;
      return dashboardJson(async () => {
        await deleteSeoOverride(session.shopId, "product", entityId);
        return { ok: true };
      });
    }
    case "updateSettings": {
      const patch: Record<string, unknown> = {};
      if (typeof body.allowAiCrawlers === "boolean") patch.allowAiCrawlers = body.allowAiCrawlers;
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
      if (Object.keys(patch).length === 0) return jsonError(422, "bad_request", "no settings to update");
      return dashboardJson(async () => ({ settings: await upsertSeoSettings(session.shopId, patch) }));
    }
    case "connectGoogle": {
      // Mint a single-use CSRF nonce bound to this shop; the callback consumes it.
      const state = await createOAuthState(getSupabase(), session.shopId, { dashboard: true });
      const url = buildConnectUrl(session.shopId, state);
      if (!url) return jsonError(503, "google_unavailable", "Google connection is not configured");
      return dashboardJson(async () => ({ url }));
    }
    case "disconnectGoogle": {
      return dashboardJson(async () => {
        await disconnectGsc(session.shopId);
        return { ok: true };
      });
    }
    default:
      return jsonError(422, "bad_request", `unknown action: ${body.action}`);
  }
}
