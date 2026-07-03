// GET  /dashboard/api/campaign-drafts — the session shop's drafts, newest first.
// POST /dashboard/api/campaign-drafts — create one draft { name, platform }.
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import { listCampaignDrafts, createCampaignDraft } from "~/lib/ads/campaign-draft.server";
import { validateCampaignDraftInput } from "~/lib/ads/campaign-draft-types";

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  return dashboardJson(async () => ({
    drafts: await listCampaignDrafts(session.shopId),
  }));
}

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");
  let body: unknown;
  try { body = await request.json(); } catch { return jsonError(422, "invalid_json"); }
  const v = validateCampaignDraftInput(body);
  if (!v.ok) return jsonError(422, v.code);
  return dashboardJson(async () => ({
    draft: await createCampaignDraft(session.shopId, v.value),
  }));
}
