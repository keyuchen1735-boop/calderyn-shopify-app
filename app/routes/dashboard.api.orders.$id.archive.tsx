import type { ActionFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, parseJsonObjectBody, requireSameOrigin } from "~/lib/dashboard/http.server";
import { isImportedOrderId, stripNativeOrderPrefix } from "~/lib/order/detail.server";
import { getSupabase } from "~/lib/supabase.server";

/** Archive/unarchive a native order (Task 10): sets or clears orders.archived_at. Native only. */
export async function action({ request, params }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");

  const rawId = String(params.id);
  if (isImportedOrderId(rawId)) {
    return jsonError(422, "imported_read_only", "Imported orders cannot be archived here.");
  }
  const orderId = stripNativeOrderPrefix(rawId);

  const body = await parseJsonObjectBody(request);
  if (!body) return jsonError(400, "bad_body", "Expected a JSON body.");
  if (typeof body.archived !== "boolean") {
    return jsonError(422, "invalid_archived", "archived must be a boolean.");
  }
  const archived = body.archived;

  return dashboardJson(async () => {
    const sb = getSupabase();
    // Existence + write in one round trip: `.select("id")` on the update returns the affected
    // rows, so an empty result IS the shop-scoped not-found case (same technique order.server.ts's
    // transitionOrder already uses to detect a 0-row outcome) — no separate SELECT needed first.
    const updRes = await sb
      .from("orders")
      .update({ archived_at: archived ? new Date().toISOString() : null })
      .eq("shop_id", session.shopId)
      .eq("id", orderId)
      .select("id");
    if (updRes.error) throw updRes.error;
    if (!updRes.data || (updRes.data as unknown[]).length === 0) {
      throw jsonError(404, "order_not_found");
    }

    return { archived };
  });
}
