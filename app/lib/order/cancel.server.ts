// app/lib/order/cancel.server.ts
//
// Cancellation executor (orders close-out phase 1): abandon an order before or during
// fulfillment -- releasing any inventory hold, refunding captured money (delegated to
// actions/refund.server.ts) or transitioning straight to `cancelled`, restocking on request, and
// auditing the result. Sibling to fulfill.server.ts / actions/refund.server.ts -- same
// idempotency-key + append-only action_audit tail.
//
// A cancellation that ALSO refunds does not additionally transition to `cancelled`:
// actions/refund.server.ts already moves the order to `refunded` (or `partially_refunded`) itself,
// and neither of those states has a `-> cancelled` edge (state.ts) -- refunded is terminal.
// "Refund on cancel" means the order's disposition IS the refund, not two separate transitions.
// The refund executor is called with a nested idempotency key (`<key>:refund`) so its own
// idempotency/audit trail is independent of (but linked to) this action's.

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "~/lib/supabase.server";
import { CalderynError } from "../calderyn.server";
import { transitionOrder } from "./order.server";
import { isOrderState, type OrderState } from "./state";
import { priorExecutionForKey, insertAuditWithIdempotency } from "../actions/execute.server";
import { restockOrderLines, releaseReservation } from "../inventory/engine.server";
import { executeRefundAction } from "../actions/refund.server";
import { sendCancellationNotice } from "./notify-email.server";

/** Order states a cancellation may act on. `cart`/`fulfilled`/`cancelled`/`refunded`/
 *  `partially_refunded` are out of reach (already shipped, already terminal, or never an order). */
const CANCELLABLE_STATES: ReadonlySet<OrderState> = new Set<OrderState>([
  "checkout_pending",
  "paid",
  "partially_fulfilled",
]);

export interface CancelActionInput {
  orderId: string;
  reason?: string | null;
  refund: boolean;
  restock: boolean;
  idempotencyKey: string;
  actor?: string;
}

export interface CancelActionResult {
  auditId: string;
  orderState: OrderState;
  refunded: boolean;
  restockedLines: number;
  replayed: boolean;
}

async function loadOrderState(sb: SupabaseClient, shopId: string, orderId: string): Promise<OrderState | null> {
  const { data, error } = await sb.from("orders").select("state").eq("shop_id", shopId).eq("id", orderId).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const state = String((data as Record<string, unknown>).state);
  return isOrderState(state) ? state : null;
}

export async function executeCancelAction(
  shopId: string,
  input: CancelActionInput,
  sb: SupabaseClient = getSupabase(),
): Promise<CancelActionResult> {
  if (!shopId) throw new Error("shopId is required");
  if (!input.orderId) {
    throw new CalderynError({ code: "invalid_cancellation", status: 422, message: "orderId is required." });
  }
  if (!input.idempotencyKey) {
    throw new CalderynError({ code: "invalid_cancellation", status: 422, message: "idempotencyKey is required." });
  }

  // 1. Idempotency: a replayed key returns the prior outcome without acting again.
  const prior = await priorExecutionForKey(shopId, input.idempotencyKey, sb);
  if (prior) {
    const state = await loadOrderState(sb, shopId, input.orderId);
    if (!state) {
      throw new CalderynError({ code: "order_not_found", status: 404, message: `Order ${input.orderId} not found.` });
    }
    return {
      auditId: prior.id,
      orderState: state,
      refunded: state === "refunded" || state === "partially_refunded",
      restockedLines: 0,
      replayed: true,
    };
  }

  // 2. Load order + already-cancelled / cancellable-state guards.
  const orderRes = await sb.from("orders").select("id, state, cancelled_at").eq("shop_id", shopId).eq("id", input.orderId).maybeSingle();
  if (orderRes.error) throw orderRes.error;
  if (!orderRes.data) {
    throw new CalderynError({ code: "order_not_found", status: 404, message: `Order ${input.orderId} not found.` });
  }
  const orderRow = orderRes.data as Record<string, unknown>;
  const fromStateRaw = String(orderRow.state);
  if (orderRow.cancelled_at != null || fromStateRaw === "cancelled") {
    throw new CalderynError({ code: "already_cancelled", status: 409, message: `Order ${input.orderId} is already cancelled.` });
  }
  if (!isOrderState(fromStateRaw) || !CANCELLABLE_STATES.has(fromStateRaw)) {
    throw new CalderynError({
      code: "order_not_cancellable",
      status: 409,
      message: `Order ${input.orderId} is '${fromStateRaw}'; only a checkout-pending, paid, or partially-fulfilled order can be cancelled.`,
    });
  }
  const fromState = fromStateRaw as OrderState;

  const reason = input.reason ?? null;
  let orderState: OrderState = fromState;
  let refunded = false;
  let restockedLines = 0;
  const params: Record<string, unknown> = {
    reason,
    refund: input.refund,
    restock: input.restock,
    restockedLines: 0,
  };

  if (fromState === "checkout_pending") {
    // 3. Nothing captured yet -- free the hold and cancel outright. A refund request against
    // uncaptured money is a no-op, recorded so the caller sees it was ignored, never silently dropped.
    await releaseReservation(shopId, input.orderId);
    await transitionOrder(shopId, input.orderId, "cancelled", reason ?? "merchant:cancel");
    orderState = "cancelled";
    if (input.refund) params.refund_skipped = "not_captured";
  } else if (input.refund) {
    // 4. Paid/partially_fulfilled + refund requested: delegate to the refund executor, which moves
    // the order to refunded/partially_refunded and handles its own restock. Do NOT also transition
    // to cancelled -- that edge does not exist from refunded/partially_refunded.
    const refundResult = await executeRefundAction(
      shopId,
      {
        orderId: input.orderId,
        idempotencyKey: `${input.idempotencyKey}:refund`,
        actor: input.actor,
        reason: reason ?? "order cancelled",
        restock: input.restock,
      },
      sb,
    );
    orderState = refundResult.orderState;
    refunded = true;
    restockedLines = refundResult.restockedLines;
    params.restockedLines = restockedLines;
  } else {
    // 5. Paid/partially_fulfilled, no refund: transition straight to cancelled; restock committed
    // stock on request (the refund branch above already handles restock for its own path).
    await transitionOrder(shopId, input.orderId, "cancelled", reason ?? "merchant:cancel");
    orderState = "cancelled";
    if (input.restock) {
      const r = await restockOrderLines(shopId, input.orderId, "cancel");
      restockedLines = r.restockedLines;
      params.restockedLines = restockedLines;
      if (r.failedVariantIds.length > 0) {
        params.restock_error = `restock failed for variants: ${r.failedVariantIds.join(", ")}`;
        console.error(
          `[cancel] order ${input.orderId}: restock partially failed for variants ${r.failedVariantIds.join(", ")} -- reconcile inventory manually`,
        );
      }
    }
  }

  // 6. Stamp cancelled_at + cancel_reason on EVERY success path -- including the refund branch,
  // where `state` already moved to refunded/partially_refunded but the merchant's cancel intent
  // still needs a visible timestamp/reason distinct from the refund's own bookkeeping.
  const stampRes = await sb
    .from("orders")
    .update({ cancelled_at: new Date().toISOString(), cancel_reason: reason })
    .eq("shop_id", shopId)
    .eq("id", input.orderId);
  if (stampRes.error) throw stampRes.error;

  // 7. Best-effort buyer notification (never throws).
  await sendCancellationNotice(shopId, input.orderId, { refunded });

  // 8. One append-only audit row + idempotency marker.
  const audit = await insertAuditWithIdempotency(
    shopId,
    input.idempotencyKey,
    {
      alert_id: null,
      action_kind: "cancel_order",
      params,
      outcome: "succeeded",
      pre_state: { state: fromState },
      post_state: { state: orderState },
      last_error: null,
      actor_user_id: input.actor ?? "merchant",
      write_target: "owned_sot",
    },
    sb,
  );

  return { auditId: audit.id, orderState, refunded, restockedLines, replayed: false };
}
