import type { ActionFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, parseJsonObjectBody, requireSameOrigin } from "~/lib/dashboard/http.server";
import { validateBulkOrderIds, runBulkOrderAction } from "~/lib/order/bulk.server";
import { setOrderArchived } from "~/lib/order/order.server";

/**
 * Bulk archive/unarchive (orders power tools, Phase 2 Task 3). Shares setOrderArchived
 * (order.server.ts) with the single-order route ($id.archive.tsx) so the
 * `orders.archived_at` update is written exactly once, not duplicated. Runs in batches of 5 via
 * runBulkOrderAction: one order failing (unknown, wrong shop) never aborts the rest of the
 * selection.
 */
export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");

  const body = await parseJsonObjectBody(request);
  if (!body) return jsonError(400, "bad_body", "Expected a JSON body.");

  const validated = validateBulkOrderIds(body.order_ids);
  if (!validated.ok) return jsonError(422, validated.code, validated.message);

  if (typeof body.archived !== "boolean") {
    return jsonError(422, "invalid_archived", "archived must be a boolean.");
  }
  const archived = body.archived;

  return dashboardJson(async () => {
    const results = await runBulkOrderAction(validated.orderIds, async (orderId) => {
      const result = await setOrderArchived(session.shopId, orderId, archived);
      return { archived: result };
    });
    return { results };
  });
}
