import type { ActionFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import { undoAction } from "~/lib/actions/undo.server";
import { getSupabase } from "~/lib/supabase.server";

export async function action({ request, params }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");

  return dashboardJson(async () => {
    const result = await undoAction(session.shopId, String(params.id), getSupabase());
    return { audit_id: result.id };
  });
}
