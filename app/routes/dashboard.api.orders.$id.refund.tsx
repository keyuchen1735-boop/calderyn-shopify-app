import type { ActionFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, parseJsonObjectBody, requireSameOrigin } from "~/lib/dashboard/http.server";
import { isImportedOrderId, stripNativeOrderPrefix } from "~/lib/order/detail.server";
import { executeRefundAction } from "~/lib/actions/refund.server";
import { getSupabase } from "~/lib/supabase.server";

/**
 * Merchant-initiated refund on the dashboard surface (#3b). Issues a Stripe refund against an
 * owned order, writes the negative ledger row, transitions the order, and emits native refund_fact
 * — all in the shared executor so this surface and the Polaris app.orders route stay in lockstep.
 * No Shopify admin client is needed: the refund is a Stripe + warehouse operation on Calderyn's
 * own checkout, not a Shopify refund.
 */
export async function action({ request, params }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");

  // Imported (Shopify-mirrored) orders are read-only here — reject them and strip any
  // native `calderyn:` prefix, mirroring every sibling order write route so the same id
  // that works on fulfill/cancel/tags resolves here too.
  const rawId = String(params.id);
  if (isImportedOrderId(rawId)) {
    return jsonError(422, "imported_read_only", "Imported orders cannot be refunded here.");
  }
  const orderId = stripNativeOrderPrefix(rawId);

  // Validate the JSON body at the boundary — never trust its shape. parseJsonObjectBody
  // normalizes a bare null/array/primitive body to {} and only returns null on a JSON
  // parse failure, so a body of literally `null` can no longer crash the field reads below.
  const body = await parseJsonObjectBody(request);
  if (!body) return jsonError(400, "bad_body", "Expected a JSON body.");
  const idempotencyKey = typeof body.idempotency_key === "string" ? body.idempotency_key : "";
  if (!idempotencyKey) return jsonError(422, "missing_idempotency_key", "idempotency_key is required.");

  // amount_cents omitted -> full remaining refund. When present it must be a positive integer.
  let amountCents: number | undefined;
  if (body.amount_cents !== undefined && body.amount_cents !== null) {
    const n = Number(body.amount_cents);
    if (!Number.isInteger(n) || n <= 0) {
      return jsonError(422, "invalid_amount", "amount_cents must be a positive whole number of cents.");
    }
    amountCents = n;
  }
  const reason = typeof body.reason === "string" ? body.reason : null;

  // restock omitted -> no restock attempt. When present it must be a boolean.
  let restock: boolean | undefined;
  if (body.restock !== undefined && body.restock !== null) {
    if (typeof body.restock !== "boolean") {
      return jsonError(422, "invalid_restock", "restock must be a boolean.");
    }
    restock = body.restock;
  }

  return dashboardJson(async () => {
    const result = await executeRefundAction(
      session.shopId,
      { orderId, amountCents, idempotencyKey, actor: "merchant:web-dashboard", reason, restock },
      getSupabase(),
    );
    return {
      audit_id: result.auditId,
      refund_id: result.refundId,
      amount_cents: result.amountCents,
      order_state: result.orderState,
      refunded_total_cents: result.refundedTotalCents,
      captured_cents: result.capturedCents,
      restocked_lines: result.restockedLines,
      restock_error: result.restockError,
    };
  });
}
