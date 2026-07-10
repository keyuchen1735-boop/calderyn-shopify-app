import type { ActionFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, parseJsonObjectBody, requireSameOrigin } from "~/lib/dashboard/http.server";
import { validateBulkOrderIds, runBulkOrderAction } from "~/lib/order/bulk.server";
import { addOrderTags } from "~/lib/order/tags.server";

/**
 * Bulk additive tags (orders power tools, Phase 2 Task 3): adds `add_tags` to every requested
 * order WITHOUT removing any tag already there — NEVER the full-replace path ($id.tags.tsx).
 * addOrderTags normalizes/validates the list and unions it with each order's existing tags, so
 * the same request can succeed on one order and 422 (too_many_tags) on another that's already
 * near the per-order cap — that's normal, expected partial-failure output, not a whole-request
 * error. Runs in batches of 5 via runBulkOrderAction.
 */
export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");

  const body = await parseJsonObjectBody(request);
  if (!body) return jsonError(400, "bad_body", "Expected a JSON body.");

  const validated = validateBulkOrderIds(body.order_ids);
  if (!validated.ok) return jsonError(422, validated.code, validated.message);

  if (!Array.isArray(body.add_tags)) {
    return jsonError(422, "invalid_tags", "add_tags must be an array of strings.");
  }
  const addTags = body.add_tags as string[];

  return dashboardJson(async () => {
    const results = await runBulkOrderAction(validated.orderIds, async (orderId) => {
      const tags = await addOrderTags(session.shopId, orderId, addTags);
      return { tags };
    });
    return { results };
  });
}
