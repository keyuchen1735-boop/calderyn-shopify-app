import type { ActionFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, parseJsonObjectBody, requireSameOrigin } from "~/lib/dashboard/http.server";
import { isImportedOrderId, nativeOrderExists, stripNativeOrderPrefix } from "~/lib/order/detail.server";
import { normalizeOrderTags, MAX_ORDER_TAGS } from "~/lib/order/tags";
import { getSupabase } from "~/lib/supabase.server";

/** Full-replace order tags (Task 10): delete-then-insert, shop+order scoped. Native only. */
export async function action({ request, params }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");

  const rawId = String(params.id);
  if (isImportedOrderId(rawId)) {
    return jsonError(422, "imported_read_only", "Imported orders cannot be tagged here.");
  }
  const orderId = stripNativeOrderPrefix(rawId);

  const body = await parseJsonObjectBody(request);
  if (!body) return jsonError(400, "bad_body", "Expected a JSON body.");

  const tags = normalizeOrderTags(body.tags);
  if (!tags) {
    return jsonError(422, "invalid_tags", `tags must be an array of 1-60 char strings, at most ${MAX_ORDER_TAGS}.`);
  }

  return dashboardJson(async () => {
    const sb = getSupabase();
    if (!(await nativeOrderExists(session.shopId, orderId, sb))) {
      throw jsonError(404, "order_not_found");
    }

    // Full replace is delete-then-insert (two round trips, not one atomic statement — same
    // accepted non-atomicity the fulfill/cancel/refund executors document for their own multi-step
    // writes). A failure between the two calls is surfaced loudly (dashboardJson's catch-all
    // console.errors + 500s rather than swallowing it), never silently — but is not rolled back;
    // reconciling a partial tag-replace is the same manual-reconcile ceiling those executors accept.
    const delRes = await sb.from("order_tag").delete().eq("shop_id", session.shopId).eq("order_id", orderId);
    if (delRes.error) throw delRes.error;

    if (tags.length > 0) {
      const insRes = await sb
        .from("order_tag")
        .insert(tags.map((tag) => ({ shop_id: session.shopId, order_id: orderId, tag })));
      if (insRes.error) throw insRes.error;
    }

    return { tags };
  });
}
