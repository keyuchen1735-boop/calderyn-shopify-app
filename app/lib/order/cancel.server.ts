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
//
// CRASH WINDOW (rule 12, same shape as fulfill.server.ts / refund.server.ts): the branches below
// are several non-transactional PostgREST/RPC calls, not one atomic statement. cancelled_at/
// cancel_reason is stamped IMMEDIATELY after each branch's state-changing call (transitionOrder,
// or executeRefundAction in the refund branch) to shrink -- not close -- the window between the
// money/state move and the audit tail. A crash inside that window (refund branch) leaves the order
// refunded with cancelled_at still null; a retry of the SAME outer key would otherwise see a
// non-cancellable state and 409. Instead the validation step detects a completed `<key>:refund`
// execution and RESUMES: stamps cancelled_at, writes the outer audit row, sends no second refund,
// and skips the buyer notice (at-most-once beats at-least-once here). Folding the stamp+audit into
// the refund/transition RPC itself is the same GA upgrade transitionOrder's and
// record_refund_ledger's headers already defer.

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "~/lib/supabase.server";
import { CalderynError } from "../calderyn.server";
import { transitionOrder } from "./order.server";
import { isOrderState, type OrderState } from "./state";
import { priorExecutionForKey, insertAuditWithIdempotency } from "../actions/execute.server";
import { restockOrderLines, releaseReservation } from "../inventory/engine.server";
import { executeRefundAction } from "../actions/refund.server";
import { sendCancellationNotice } from "./notify-email.server";
import { expireInvoiceSession } from "./invoice.server";

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

/**
 * Hardening (code-review finding): the crash-resume gate below used to trust a literal
 * idempotency-key match alone — `<key>:refund` existing as SOME completed execution — without
 * proving that execution was a refund of THIS order. Idempotency keys are caller-supplied
 * strings; a client bug (or two orders sharing a naive key scheme) could collide the OUTER key
 * across two different orders and, since both would then probe the SAME `<key>:refund` inner
 * key, incorrectly resume order B onto order A's completed refund. Close that by re-reading the
 * matched action_audit row and checking both `action_kind` (must be the refund executor, not
 * some unrelated action that happened to share a key) and `params->>order_id` (refund.server.ts
 * persists `order_id` — snake_case, see its module header) against `input.orderId`. Only a
 * proven refund-of-THIS-order resumes; anything else falls through to the normal 409.
 */
async function priorRefundBelongsToThisOrder(
  sb: SupabaseClient,
  shopId: string,
  auditId: string,
  orderId: string,
): Promise<boolean> {
  const { data, error } = await sb
    .from("action_audit")
    .select("action_kind, outcome, params")
    .eq("shop_id", shopId)
    .eq("id", auditId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return false;
  const row = data as Record<string, unknown>;
  // Belt-and-braces: refund.server.ts's RefundActionResult types `outcome` as the literal
  // "succeeded" (every issue_refund audit insert passes that literal, never a variable — see its
  // module header's ATOMICITY note: a Stripe failure throws before any audit row is written), so
  // a non-succeeded issue_refund row is not reachable today. Checking it anyway costs one extra
  // selected column and closes the gap outright should that invariant ever loosen.
  if (row.action_kind !== "issue_refund" || row.outcome !== "succeeded") return false;
  const params = (row.params ?? {}) as Record<string, unknown>;
  return params.order_id === orderId;
}

/** Stamp cancelled_at + cancel_reason. Called IMMEDIATELY after each branch's state-changing step
 *  (transitionOrder, or executeRefundAction in the refund branch) so the crash window between the
 *  money/state move and this visible marker is as small as this non-transactional shape allows. */
async function stampCancelled(
  sb: SupabaseClient,
  shopId: string,
  orderId: string,
  reason: string | null,
): Promise<void> {
  const stampRes = await sb
    .from("orders")
    .update({ cancelled_at: new Date().toISOString(), cancel_reason: reason })
    .eq("shop_id", shopId)
    .eq("id", orderId);
  if (stampRes.error) throw stampRes.error;
}

/**
 * Crash-resume for the refund branch (see module header). A prior call with this exact outer
 * idempotencyKey already delegated to executeRefundAction -- proven by a completed `<key>:refund`
 * execution -- and crashed before the cancelled_at stamp / outer audit row landed. The refund
 * itself is done and money already moved, so this path only finishes the bookkeeping: it never
 * calls executeRefundAction again (that would risk a double-refund), and it skips the buyer notice
 * rather than resend it -- there's no way to prove the first attempt's notice landed or failed, and
 * at-most-once is the safer default for a "your refund happened" email than a duplicate. Reached
 * only when cancelled_at is still null (the already_cancelled guard above catches a completed one).
 */
async function resumeAfterRefundCrash(
  sb: SupabaseClient,
  shopId: string,
  input: CancelActionInput,
  orderState: OrderState,
): Promise<CancelActionResult> {
  const reason = input.reason ?? null;
  await stampCancelled(sb, shopId, input.orderId, reason);

  const audit = await insertAuditWithIdempotency(
    shopId,
    input.idempotencyKey,
    {
      alert_id: null,
      action_kind: "cancel_order",
      params: {
        order_id: input.orderId,
        reason,
        refund: true,
        restock: input.restock,
        resumed_after_refund_crash: true,
      },
      outcome: "succeeded",
      pre_state: { state: orderState },
      post_state: { state: orderState },
      last_error: null,
      actor_user_id: input.actor ?? "merchant",
      write_target: "owned_sot",
    },
    sb,
  );

  return { auditId: audit.id, orderState, refunded: true, restockedLines: 0, replayed: false };
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
  const orderRes = await sb.from("orders").select("id, state, cancelled_at, channel").eq("shop_id", shopId).eq("id", input.orderId).maybeSingle();
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
    // Crash-resume check (Finding 2 / module header): a completed `<key>:refund` execution proves
    // THIS cancel already ran the refund branch and moved the order to refunded/partially_refunded
    // before crashing. Resume rather than 409 -- only reachable with cancelled_at still null, since
    // the already_cancelled guard above short-circuits a completed stamp.
    if (input.refund && isOrderState(fromStateRaw) && (fromStateRaw === "refunded" || fromStateRaw === "partially_refunded")) {
      const priorRefund = await priorExecutionForKey(shopId, `${input.idempotencyKey}:refund`, sb);
      if (priorRefund && (await priorRefundBelongsToThisOrder(sb, shopId, priorRefund.id, input.orderId))) {
        return resumeAfterRefundCrash(sb, shopId, input, fromStateRaw);
      }
    }
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
    order_id: input.orderId,
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
    // Stamp immediately after the state move (module header: shrink the crash window).
    await stampCancelled(sb, shopId, input.orderId, reason);
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
    // Stamp immediately after the refund delegate returns -- this is the crash window Finding 2 /
    // the resume path above closes for: a crash between here and the audit tail is what a retry
    // with the same outer key resumes from, above.
    await stampCancelled(sb, shopId, input.orderId, reason);
  } else {
    // 5. Paid/partially_fulfilled, no refund: transition straight to cancelled; restock committed
    // stock on request (the refund branch above already handles restock for its own path).
    await transitionOrder(shopId, input.orderId, "cancelled", reason ?? "merchant:cancel");
    orderState = "cancelled";
    // Stamp immediately after the state move (module header: shrink the crash window).
    await stampCancelled(sb, shopId, input.orderId, reason);
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

  // 5b. Fix C2: an invoice-channel order can have a hosted pay-link session sitting open in a
  // buyer's browser — kill it now that the order is cancelled/refunded, so that session can never
  // complete a payment on an order the merchant just voided. Best-effort: the cancellation itself
  // already succeeded and committed above, so a failure clearing the session must never turn an
  // otherwise-successful cancel into a 500 -- log loudly and move on (rule 12).
  if (orderRow.channel === "invoice") {
    try {
      await expireInvoiceSession(shopId, input.orderId);
    } catch (err) {
      console.error(
        `[cancel] order ${input.orderId}: could not expire the invoice's hosted pay-link session -- reconcile manually if the buyer reports a stale link`,
        err,
      );
    }
  }

  // 6. Best-effort buyer notification (never throws).
  await sendCancellationNotice(shopId, input.orderId, { refunded });

  // 7. One append-only audit row + idempotency marker.
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
