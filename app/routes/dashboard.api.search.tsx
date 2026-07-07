// app/routes/dashboard.api.search.tsx
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import { getSeoSettings, upsertSeoSettings } from "~/lib/seo/seo-store.server";

// The Preferences screen (see Search.tsx) exposes only the controls a merchant
// has — search-engine access, AI-assistant access, and an optional store
// description. The loader hands back just this shop's SEO settings.
export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request); // auth gate; settings are this shop's own data
  return dashboardJson(async () => ({ settings: await getSeoSettings(session.shopId) }));
}

interface SearchBody {
  action?: string;
  allowSearchEngines?: boolean;
  allowAiCrawlers?: boolean;
  orgName?: string | null;
  orgDescription?: string | null;
}

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
    case "updateSettings": {
      const patch: Record<string, unknown> = {};
      if (typeof body.allowSearchEngines === "boolean") patch.allowSearchEngines = body.allowSearchEngines;
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
    default:
      return jsonError(422, "bad_request", `unknown action: ${body.action}`);
  }
}
