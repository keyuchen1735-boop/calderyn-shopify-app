// GET    /dashboard/api/campaign-drafts — the session shop's drafts, newest first.
// POST   /dashboard/api/campaign-drafts — create one draft { name, platform }.
// DELETE /dashboard/api/campaign-drafts?id=<uuid> — remove one draft (shop-scoped).
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import {
  dashboardJson,
  jsonError,
  requireSameOrigin,
} from "~/lib/dashboard/http.server";
import {
  listCampaignDrafts,
  createCampaignDraft,
  deleteCampaignDraft,
  updateCampaignDraft,
} from "~/lib/ads/campaign-draft.server";
import { validateCampaignDraftInput } from "~/lib/ads/campaign-draft-types";
import { isUuid } from "~/lib/ids";

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  return dashboardJson(async () => ({
    drafts: await listCampaignDrafts(session.shopId),
  }));
}

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);

  if (request.method === "DELETE") {
    const id = new URL(request.url).searchParams.get("id");
    if (!id) return jsonError(422, "missing_id");
    if (!isUuid(id)) return jsonError(422, "invalid_id");
    return dashboardJson(async () => {
      const removed = await deleteCampaignDraft(session.shopId, id);
      if (!removed) throw jsonError(404, "not_found");
      return { ok: true };
    });
  }

  if (request.method === "PUT") {
    const id = new URL(request.url).searchParams.get("id");
    if (!id) return jsonError(422, "missing_id");
    if (!isUuid(id)) return jsonError(422, "invalid_id");
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonError(422, "invalid_json");
    }
    const validated = validateCampaignDraftInput(body);
    if (!validated.ok) return jsonError(422, validated.code);
    return dashboardJson(async () => {
      const draft = await updateCampaignDraft(
        session.shopId,
        id,
        validated.value,
      );
      if (!draft) throw jsonError(404, "not_found");
      return { draft };
    });
  }

  if (request.method !== "POST") return jsonError(405, "method_not_allowed");
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(422, "invalid_json");
  }
  const v = validateCampaignDraftInput(body);
  if (!v.ok) return jsonError(422, v.code);
  return dashboardJson(async () => ({
    draft: await createCampaignDraft(session.shopId, v.value),
  }));
}
