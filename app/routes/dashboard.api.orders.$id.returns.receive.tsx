// app/routes/dashboard.api.orders.$id.returns.receive.tsx
// POST { return_id, idempotency_key } -> executeReturnReceivedAction (orders Phase 4, Task 2):
// restocks the return's requested lines and refunds its total, then flips it closed. Every domain
// failure (return_not_found, return_not_open, over_refund, qty_exceeds_returnable, ...) is a
// CalderynError the executor already throws; dashboardJson maps it, this route adds no handling
// of its own beyond boundary validation.
import type { ActionFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, parseJsonObjectBody, requireSameOrigin } from "~/lib/dashboard/http.server";
import { isImportedOrderId } from "~/lib/order/detail.server";
import { executeReturnReceivedAction } from "~/lib/order/returns.server";

export async function action({ request, params }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");

  const rawId = String(params.id);
  if (isImportedOrderId(rawId)) {
    return jsonError(422, "imported_read_only", "Imported orders cannot have returns received here.");
  }

  const body = await parseJsonObjectBody(request);
  if (!body) return jsonError(400, "bad_body", "Expected a JSON body.");

  const returnId = typeof body.return_id === "string" ? body.return_id : "";
  if (!returnId) return jsonError(422, "invalid_return_id", "return_id is required.");

  const idempotencyKey = typeof body.idempotency_key === "string" ? body.idempotency_key : "";
  if (!idempotencyKey) return jsonError(422, "missing_idempotency_key", "idempotency_key is required.");

  return dashboardJson(async () => {
    const result = await executeReturnReceivedAction(session.shopId, {
      returnId,
      idempotencyKey,
      actor: "merchant:web-dashboard",
    });
    return {
      audit_id: result.auditId,
      return_id: result.returnId,
      order_id: result.orderId,
      status: result.status,
      refunded_cents: result.refundedCents,
      restocked_lines: result.restockedLines,
      restock_errors: result.restockErrors,
      replayed: result.replayed,
    };
  });
}
