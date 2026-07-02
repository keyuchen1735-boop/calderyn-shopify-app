import type { ActionFunctionArgs } from "react-router";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import { undoAction } from "~/lib/actions/undo.server";
import { getSupabase } from "~/lib/supabase.server";
import type { AdminGraphqlClient } from "~/lib/shopify/inventory.server";
import { unauthenticated } from "~/shopify.server";

export async function action({ request, params }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");

  return dashboardJson(async () => {
    // Best-effort: only inventory undos need Shopify admin; a missing offline
    // session must not break campaign undos. The executor refuses loudly when
    // an inventory undo arrives without it.
    let admin: AdminGraphqlClient | undefined;
    try {
      ({ admin } = await unauthenticated.admin(session.shopDomain ?? ""));
    } catch (err) {
      console.error("[undo] unauthenticated.admin failed — proceeding without Shopify admin client", err);
      admin = undefined;
    }
    const result = await undoAction(session.shopId, String(params.id), getSupabase(), { admin });
    return { audit_id: result.id };
  });
}
