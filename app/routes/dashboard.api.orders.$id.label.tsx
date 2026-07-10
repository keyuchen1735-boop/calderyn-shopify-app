import type { ActionFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, parseJsonObjectBody, requireSameOrigin, rateLimit } from "~/lib/dashboard/http.server";
import { isImportedOrderId, stripNativeOrderPrefix } from "~/lib/order/detail.server";
import { buyLabelAndFulfill, quoteLabelRates } from "~/lib/order/label.server";
import { parseFulfillLinesBody } from "~/lib/order/fulfill.server";

/**
 * EasyPost label purchase inside the fulfill flow (shipping deferred D2). Two intents:
 *   { intent: "quote" }                                    → create shipment, return rates
 *   { intent: "buy", shipment_id, rate_id, lines?, notify, idempotency_key } → buy + fulfill
 * MONEY: `buy` spends the merchant's EasyPost balance — the server side is fail-closed and
 * idempotent on the shipment id (see label.server.ts). Native orders only.
 */
export async function action({ request, params }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");

  const rawId = String(params.id);
  if (isImportedOrderId(rawId)) {
    return jsonError(422, "imported_read_only", "Imported orders cannot buy labels here.");
  }
  const orderId = stripNativeOrderPrefix(rawId);

  // Every quote creates a shipment at EasyPost; keep a per-shop lid on it.
  if (!(await rateLimit(`order-label:${session.shopId}`, 30, 60_000))) {
    return jsonError(429, "rate_limited");
  }

  const body = await parseJsonObjectBody(request);
  if (!body) return jsonError(400, "bad_body", "Expected a JSON body.");
  const intent = String(body.intent ?? "");

  if (intent === "quote") {
    // The parcel is rated for the units the merchant is actually shipping, so the modal
    // passes its selected lines; omitted = everything unfulfilled.
    const parsed = parseFulfillLinesBody(body.lines);
    if (!parsed.ok) return jsonError(422, parsed.code, parsed.message);
    return dashboardJson(async () => {
      const created = await quoteLabelRates(session.shopId, orderId, parsed.lines);
      return {
        shipment_id: created.shipmentId,
        rates: created.rates.map((r) => ({
          id: r.id,
          carrier: r.carrier,
          service: r.service,
          amount_cents: r.amountCents,
          est_delivery_days: r.estDeliveryDays,
        })),
      };
    });
  }

  if (intent === "buy") {
    const shipmentId = typeof body.shipment_id === "string" ? body.shipment_id.trim() : "";
    const rateId = typeof body.rate_id === "string" ? body.rate_id.trim() : "";
    if (!shipmentId || !rateId) return jsonError(422, "invalid_label_buy", "shipment_id and rate_id are required.");
    const idempotencyKey = typeof body.idempotency_key === "string" ? body.idempotency_key : "";
    if (!idempotencyKey) return jsonError(422, "missing_idempotency_key", "idempotency_key is required.");
    if (typeof body.notify !== "boolean") return jsonError(422, "invalid_notify", "notify must be a boolean.");
    const notify = body.notify;

    const parsed = parseFulfillLinesBody(body.lines);
    if (!parsed.ok) return jsonError(422, parsed.code, parsed.message);
    const lines = parsed.lines;

    return dashboardJson(async () => {
      const result = await buyLabelAndFulfill(session.shopId, {
        orderId,
        shipmentId,
        rateId,
        lines,
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
        replayed: result.replayed,
        label_url: result.labelUrl,
        label_cost_cents: result.labelCostCents,
        tracking_number: result.trackingNumber,
        carrier: result.carrier,
      };
    });
  }

  return jsonError(422, "invalid_intent");
}
