import type { ActionFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, parseJsonObjectBody, requireSameOrigin } from "~/lib/dashboard/http.server";
import { isImportedOrderId, stripNativeOrderPrefix } from "~/lib/order/detail.server";
import { executeCancelAction } from "~/lib/order/cancel.server";

/**
 * Merchant-initiated cancellation (orders close-out phase 1, #10): abandon an order before or
 * during fulfillment, optionally refunding and/or restocking, via the shared audited executor.
 * Native orders only — a mirrored Shopify order is refused with 422 imported_read_only.
 */
export async function action({ request, params }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");

  const rawId = String(params.id);
  if (isImportedOrderId(rawId)) {
    return jsonError(422, "imported_read_only", "Imported orders cannot be cancelled here.");
  }
  const orderId = stripNativeOrderPrefix(rawId);

  const body = await parseJsonObjectBody(request);
  if (!body) return jsonError(400, "bad_body", "Expected a JSON body.");

  const idempotencyKey = typeof body.idempotency_key === "string" ? body.idempotency_key : "";
  if (!idempotencyKey) return jsonError(422, "missing_idempotency_key", "idempotency_key is required.");

  if (typeof body.refund !== "boolean") return jsonError(422, "invalid_refund", "refund must be a boolean.");
  if (typeof body.restock !== "boolean") return jsonError(422, "invalid_restock", "restock must be a boolean.");
  const refund = body.refund;
  const restock = body.restock;
  const reason = typeof body.reason === "string" ? body.reason : null;

  return dashboardJson(async () => {
    const result = await executeCancelAction(session.shopId, {
      orderId,
      reason,
      refund,
      restock,
      idempotencyKey,
      actor: "merchant:web-dashboard",
    });
    return {
      audit_id: result.auditId,
      order_state: result.orderState,
      refunded: result.refunded,
      restocked_lines: result.restockedLines,
    };
  });
}
