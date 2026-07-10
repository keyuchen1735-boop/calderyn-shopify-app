// app/routes/dashboard.api.orders.$id.returns.cancel.tsx
// POST { return_id } -> cancelOrderReturn (orders Phase 4, Task 2). Only an OPEN return may be
// cancelled (a CAS update, 409 return_not_cancellable otherwise) — no refund/restock effect,
// nothing to undo.
import type { ActionFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, parseJsonObjectBody, requireSameOrigin } from "~/lib/dashboard/http.server";
import { isImportedOrderId } from "~/lib/order/detail.server";
import { cancelOrderReturn } from "~/lib/order/returns.server";

export async function action({ request, params }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");

  const rawId = String(params.id);
  if (isImportedOrderId(rawId)) {
    return jsonError(422, "imported_read_only", "Imported orders cannot have returns cancelled here.");
  }

  const body = await parseJsonObjectBody(request);
  if (!body) return jsonError(400, "bad_body", "Expected a JSON body.");

  const returnId = typeof body.return_id === "string" ? body.return_id : "";
  if (!returnId) return jsonError(422, "invalid_return_id", "return_id is required.");

  return dashboardJson(async () => {
    const result = await cancelOrderReturn(session.shopId, returnId);
    return { return_id: result.returnId, status: result.status };
  });
}
