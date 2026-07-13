import type { ActionFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, parseJsonObjectBody, requireSameOrigin } from "~/lib/dashboard/http.server";
import { isImportedOrderId, stripNativeOrderPrefix } from "~/lib/order/detail.server";
import { executeFulfillAction, parseFulfillLinesBody } from "~/lib/order/fulfill.server";

/**
 * Merchant-initiated fulfillment (orders close-out phase 1, #10). Ships all-or-some order
 * lines, transitions the order, and audits it — the shared executor so this surface and any
 * future MCP/autopilot caller stay in lockstep. Native orders only: a mirrored Shopify order
 * has no owned fulfillment spine, so a `shopify:`-prefixed id is refused outright.
 */
export async function action({ request, params }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");

  const rawId = String(params.id);
  if (isImportedOrderId(rawId)) {
    return jsonError(422, "imported_read_only", "Imported orders cannot be fulfilled here.");
  }
  const orderId = stripNativeOrderPrefix(rawId);

  const body = await parseJsonObjectBody(request);
  if (!body) return jsonError(400, "bad_body", "Expected a JSON body.");

  const idempotencyKey = typeof body.idempotency_key === "string" ? body.idempotency_key : "";
  if (!idempotencyKey) return jsonError(422, "missing_idempotency_key", "idempotency_key is required.");

  if (typeof body.notify !== "boolean") {
    return jsonError(422, "invalid_notify", "notify must be a boolean.");
  }
  const notify = body.notify;

  const parsed = parseFulfillLinesBody(body.lines);
  if (!parsed.ok) return jsonError(422, parsed.code, parsed.message);
  const lines = parsed.lines;

  const trackingNumber = typeof body.tracking_number === "string" ? body.tracking_number : null;
  const carrier = typeof body.carrier === "string" ? body.carrier : null;

  return dashboardJson(async () => {
    const result = await executeFulfillAction(session.shopId, {
      orderId,
      lines,
      trackingNumber,
      carrier,
      notify,
      idempotencyKey,
      actor: "merchant:web-dashboard",
    });
    return {
      audit_id: result.auditId,
      fulfillment_id: result.fulfillmentId,
      order_state: result.orderState,
      fulfilled_units: result.fulfilledUnits,
      notified: result.notified,
    };
  });
}
