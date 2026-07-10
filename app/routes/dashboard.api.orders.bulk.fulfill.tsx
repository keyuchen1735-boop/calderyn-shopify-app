import type { ActionFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, parseJsonObjectBody, requireSameOrigin } from "~/lib/dashboard/http.server";
import { validateBulkOrderIds, validateIdempotencyKey, runBulkOrderAction } from "~/lib/order/bulk.server";
import { executeFulfillAction } from "~/lib/order/fulfill.server";

// Bulk fulfill loops up to 25 audited executors (each ~10 DB round trips, plus an
// optional buyer email); the platform default duration is too thin for that.
export const config = { maxDuration: 60 };

/**
 * Bulk fulfill (orders power tools, Phase 2 Task 3): ships every requested order in full — no
 * per-order lines/tracking/carrier here, that stays a single-order-only refinement
 * ($id.fulfill.tsx). Each order gets its OWN derived idempotency key
 * (`${idempotency_key}:${orderId}`), so a retried whole-batch submit resolves each order the
 * same way it did the first time without double-fulfilling any one of them. Runs in batches of
 * 5 via runBulkOrderAction: one order failing (wrong state, not found, …) never aborts the rest
 * of the selection — the response is always 200 with a per-order ok/error results array, even
 * when every order in it failed.
 */
export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");

  const body = await parseJsonObjectBody(request);
  if (!body) return jsonError(400, "bad_body", "Expected a JSON body.");

  const validated = validateBulkOrderIds(body.order_ids);
  if (!validated.ok) return jsonError(422, validated.code, validated.message);

  const idempotencyKey = validateIdempotencyKey(body.idempotency_key);
  if (!idempotencyKey) {
    return jsonError(422, "missing_idempotency_key", "idempotency_key is required.");
  }

  if (typeof body.notify !== "boolean") {
    return jsonError(422, "invalid_notify", "notify must be a boolean.");
  }
  const notify = body.notify;

  return dashboardJson(async () => {
    const results = await runBulkOrderAction(validated.orderIds, async (orderId) => {
      const result = await executeFulfillAction(session.shopId, {
        orderId,
        notify,
        idempotencyKey: `${idempotencyKey}:${orderId}`,
      });
      return {
        audit_id: result.auditId,
        fulfillment_id: result.fulfillmentId,
        order_state: result.orderState,
        fulfilled_units: result.fulfilledUnits,
        notified: result.notified,
      };
    });
    return { results };
  });
}
