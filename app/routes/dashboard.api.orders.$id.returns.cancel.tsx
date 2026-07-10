// app/routes/dashboard.api.orders.$id.returns.cancel.tsx
// POST { return_id } -> cancelOrderReturn (orders Phase 4, Task 2). Only an OPEN return may be
// cancelled (a CAS update, 409 return_not_cancellable otherwise) — no refund/restock effect,
// nothing to undo. Verifies return_id actually belongs to the URL's :id first (404 return_not_found
// on a mismatch) — a returnId alone carries no order scoping, so without this check a caller could
// cancel some OTHER order's return through this order's URL.
import type { ActionFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, parseJsonObjectBody, requireSameOrigin } from "~/lib/dashboard/http.server";
import { CalderynError } from "~/lib/calderyn.server";
import { isImportedOrderId, stripNativeOrderPrefix } from "~/lib/order/detail.server";
import { cancelOrderReturn, returnBelongsToOrder } from "~/lib/order/returns.server";

export async function action({ request, params }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");

  const rawId = String(params.id);
  if (isImportedOrderId(rawId)) {
    return jsonError(422, "imported_read_only", "Imported orders cannot have returns cancelled here.");
  }
  const orderId = stripNativeOrderPrefix(rawId);

  const body = await parseJsonObjectBody(request);
  if (!body) return jsonError(400, "bad_body", "Expected a JSON body.");

  const returnId = typeof body.return_id === "string" ? body.return_id : "";
  if (!returnId) return jsonError(422, "invalid_return_id", "return_id is required.");

  return dashboardJson(async () => {
    if (!(await returnBelongsToOrder(session.shopId, returnId, orderId))) {
      throw new CalderynError({
        code: "return_not_found",
        status: 404,
        message: `Return ${returnId} not found on order ${orderId}.`,
      });
    }
    const result = await cancelOrderReturn(session.shopId, returnId);
    return { return_id: result.returnId, status: result.status };
  });
}
