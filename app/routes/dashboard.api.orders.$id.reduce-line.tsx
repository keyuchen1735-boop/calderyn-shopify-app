import type { ActionFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, parseJsonObjectBody, requireSameOrigin } from "~/lib/dashboard/http.server";
import { isImportedOrderId, stripNativeOrderPrefix } from "~/lib/order/detail.server";
import { executeReduceLineAction } from "~/lib/order/edit.server";
import { getSupabase } from "~/lib/supabase.server";

/**
 * Merchant-initiated line reduction on a paid order (orders phase 3, Task 3). Records an
 * append-only order_line_edit row, refunds the exact delta through the shared refund executor,
 * and optionally restocks the reduced units — the shared executor so this surface and any future
 * MCP/autopilot caller stay in lockstep. Native orders only: an imported (Shopify-paid) order has
 * no owned order_line_edit spine.
 */
export async function action({ request, params }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");

  const rawId = String(params.id);
  if (isImportedOrderId(rawId)) {
    return jsonError(422, "imported_read_only", "Imported orders cannot be edited here.");
  }
  const orderId = stripNativeOrderPrefix(rawId);

  const body = await parseJsonObjectBody(request);
  if (!body) return jsonError(400, "bad_body", "Expected a JSON body.");

  const orderLineId = typeof body.order_line_id === "string" ? body.order_line_id : "";
  if (!orderLineId) return jsonError(422, "invalid_order_line_id", "order_line_id is required.");

  const newQuantity = body.new_quantity;
  if (typeof newQuantity !== "number" || !Number.isInteger(newQuantity) || newQuantity < 0) {
    return jsonError(422, "invalid_quantity", "new_quantity must be a non-negative whole number.");
  }

  if (typeof body.restock !== "boolean") {
    return jsonError(422, "invalid_restock", "restock must be a boolean.");
  }

  const idempotencyKey = typeof body.idempotency_key === "string" ? body.idempotency_key : "";
  if (!idempotencyKey) return jsonError(422, "missing_idempotency_key", "idempotency_key is required.");

  const reason = typeof body.reason === "string" ? body.reason : null;

  return dashboardJson(async () => {
    const result = await executeReduceLineAction(
      session.shopId,
      {
        orderId,
        orderLineId,
        newQuantity,
        restock: body.restock as boolean,
        reason,
        idempotencyKey,
        actor: "merchant:web-dashboard",
      },
      getSupabase(),
    );
    return {
      audit_id: result.auditId,
      order_state: result.orderState,
      refunded_cents: result.refundedCents,
      restocked: result.restocked,
      restock_error: result.restockError,
    };
  });
}
