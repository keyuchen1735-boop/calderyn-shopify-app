import type { ActionFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
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

  // Validate the JSON body at the boundary — never trust its shape.
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonError(400, "bad_body", "Expected a JSON body.");
  }
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

  return dashboardJson(async () => {
    const result = await executeRefundAction(
      session.shopId,
      { orderId: String(params.id), amountCents, idempotencyKey, actor: "merchant:web-dashboard", reason },
      getSupabase(),
    );
    return {
      audit_id: result.auditId,
      refund_id: result.refundId,
      amount_cents: result.amountCents,
      order_state: result.orderState,
      refunded_total_cents: result.refundedTotalCents,
      captured_cents: result.capturedCents,
    };
  });
}
