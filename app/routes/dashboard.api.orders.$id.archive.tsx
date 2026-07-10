import type { ActionFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, parseJsonObjectBody, requireSameOrigin } from "~/lib/dashboard/http.server";
import { isImportedOrderId, stripNativeOrderPrefix } from "~/lib/order/detail.server";
import { setOrderArchived } from "~/lib/order/order.server";

/** Archive/unarchive a native order (Task 10): sets or clears orders.archived_at. Native only.
 *  The update itself lives in setOrderArchived (order.server.ts), shared with the bulk archive
 *  route (Phase 2 Task 3) so the query is written exactly once. */
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
    const result = await setOrderArchived(session.shopId, orderId, archived);
    return { archived: result };
  });
}
