// app/lib/order/fulfill.server.ts
//
// Fulfillment executor (orders close-out phase 1): ship all-or-some order lines, transition the
// order to `fulfilled`/`partially_fulfilled`, and audit it. Sibling to actions/refund.server.ts --
// same idempotency-key + append-only action_audit tail, but no money moves here.
//
// CONCURRENCY (ponytail, same shape as transitionOrder / record_refund_ledger): the read-remaining
// -> validate -> insert sequence below is several separate non-transactional PostgREST calls, not
// one atomic statement. Two simultaneous partial-fulfillment requests for the same order can both
// read the same `remaining` snapshot and both insert fulfillment_line rows that, summed, exceed the
// ordered quantity -- a race this read-then-insert shape cannot close by itself. The idempotency key
// dedups a RETRY of the same request, and transitionOrder's CAS guards the state move, but the
// per-line over-coverage race is only closed by folding steps 3-6 into a security-definer RPC with a
// row lock -- the same GA upgrade transitionOrder's and record_refund_ledger's headers already defer.
// Until then, over-coverage is surfaced in the order detail's fulfillment list, never hidden.

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "~/lib/supabase.server";
import { CalderynError } from "../calderyn.server";
import { transitionOrder } from "./order.server";
import { isOrderState, type OrderState } from "./state";
import { priorExecutionForKey, insertAuditWithIdempotency } from "../actions/execute.server";
import { sendShippingConfirmation } from "./notify-email.server";

/** Order states a fulfillment may act on. Cart/checkout_pending are unpaid; fulfilled/cancelled/
 *  refunded/partially_refunded are past this action's reach. */
const FULFILLABLE_STATES: ReadonlySet<OrderState> = new Set<OrderState>(["paid", "partially_fulfilled"]);

export interface FulfillLineInput {
  orderLineId: string;
  quantity: number;
}

export interface FulfillActionInput {
  orderId: string;
  /** Omitted = fulfill everything unfulfilled (every line's full remaining quantity). */
  lines?: FulfillLineInput[];
  trackingNumber?: string | null;
  carrier?: string | null;
  notify: boolean;
  idempotencyKey: string;
  actor?: string;
}

export interface FulfillActionResult {
  auditId: string;
  fulfillmentId: string | null;
  orderState: OrderState;
  fulfilledUnits: number;
  notified: boolean;
  replayed: boolean;
}

interface ResolvedLine {
  orderLineId: string;
  quantity: number;
}

/** Read-only order-state lookup used both for the replay short-circuit and the initial load. */
async function loadOrderState(sb: SupabaseClient, shopId: string, orderId: string): Promise<OrderState | null> {
  const { data, error } = await sb.from("orders").select("state").eq("shop_id", shopId).eq("id", orderId).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const state = String((data as Record<string, unknown>).state);
  return isOrderState(state) ? state : null;
}

export async function executeFulfillAction(
  shopId: string,
  input: FulfillActionInput,
  sb: SupabaseClient = getSupabase(),
): Promise<FulfillActionResult> {
  if (!shopId) throw new Error("shopId is required");
  if (!input.orderId) {
    throw new CalderynError({ code: "invalid_fulfillment", status: 422, message: "orderId is required." });
  }
  if (!input.idempotencyKey) {
    throw new CalderynError({ code: "invalid_fulfillment", status: 422, message: "idempotencyKey is required." });
  }

  // 1. Idempotency: a replayed key returns the prior outcome without touching the order again.
  const prior = await priorExecutionForKey(shopId, input.idempotencyKey, sb);
  if (prior) {
    const state = await loadOrderState(sb, shopId, input.orderId);
    if (!state) {
      throw new CalderynError({ code: "order_not_found", status: 404, message: `Order ${input.orderId} not found.` });
    }
    return { auditId: prior.id, fulfillmentId: null, orderState: state, fulfilledUnits: 0, notified: false, replayed: true };
  }

  // 2. Load order + ownership/state guard.
  const orderRes = await sb.from("orders").select("id, state, buyer_id").eq("shop_id", shopId).eq("id", input.orderId).maybeSingle();
  if (orderRes.error) throw orderRes.error;
  if (!orderRes.data) {
    throw new CalderynError({ code: "order_not_found", status: 404, message: `Order ${input.orderId} not found.` });
  }
  const orderRow = orderRes.data as Record<string, unknown>;
  const fromStateRaw = String(orderRow.state);
  if (!isOrderState(fromStateRaw) || !FULFILLABLE_STATES.has(fromStateRaw)) {
    throw new CalderynError({
      code: "order_not_fulfillable",
      status: 409,
      message: `Order ${input.orderId} is '${fromStateRaw}'; only a paid or partially-fulfilled order can be fulfilled.`,
    });
  }
  const fromState = fromStateRaw as OrderState;
  const buyerId = orderRow.buyer_id == null ? null : String(orderRow.buyer_id);

  // 3. Load order lines + existing fulfillment coverage; compute remaining[lineId].
  const linesRes = await sb.from("order_line").select("id, quantity").eq("shop_id", shopId).eq("order_id", input.orderId);
  if (linesRes.error) throw linesRes.error;
  const orderLines = (linesRes.data ?? []) as Array<{ id: string; quantity: number }>;
  if (orderLines.length === 0) {
    throw new CalderynError({ code: "nothing_to_fulfil", status: 422, message: `Order ${input.orderId} has no lines.` });
  }

  const fulfillmentsRes = await sb.from("fulfillment").select("id").eq("shop_id", shopId).eq("order_id", input.orderId);
  if (fulfillmentsRes.error) throw fulfillmentsRes.error;
  const fulfillmentIds = ((fulfillmentsRes.data ?? []) as Array<{ id: string }>).map((f) => String(f.id));

  const fulfilledByLine = new Map<string, number>();
  if (fulfillmentIds.length > 0) {
    const flRes = await sb
      .from("fulfillment_line")
      .select("order_line_id, quantity")
      .eq("shop_id", shopId)
      .in("fulfillment_id", fulfillmentIds);
    if (flRes.error) throw flRes.error;
    for (const r of (flRes.data ?? []) as Array<{ order_line_id: string; quantity: number }>) {
      const id = String(r.order_line_id);
      fulfilledByLine.set(id, (fulfilledByLine.get(id) ?? 0) + Number(r.quantity ?? 0));
    }
  }

  const remaining = new Map<string, number>();
  for (const l of orderLines) {
    const id = String(l.id);
    remaining.set(id, Number(l.quantity) - (fulfilledByLine.get(id) ?? 0));
  }

  // 4. Resolve requested lines against `remaining`.
  let resolved: ResolvedLine[];
  if (input.lines !== undefined) {
    resolved = [];
    for (const req of input.lines) {
      const rem = remaining.get(req.orderLineId);
      if (rem === undefined) {
        throw new CalderynError({
          code: "line_not_on_order",
          status: 409,
          message: `Order line ${req.orderLineId} is not on order ${input.orderId}.`,
        });
      }
      if (req.quantity > rem) {
        throw new CalderynError({
          code: "over_fulfil",
          status: 422,
          message: `Order line ${req.orderLineId} has ${rem} remaining; cannot fulfill ${req.quantity}.`,
        });
      }
      if (req.quantity > 0) resolved.push({ orderLineId: req.orderLineId, quantity: req.quantity });
    }
    if (resolved.length === 0) {
      throw new CalderynError({
        code: "nothing_to_fulfil",
        status: 422,
        message: `Order ${input.orderId} has nothing to fulfill for the requested lines.`,
      });
    }
  } else {
    resolved = [];
    for (const [orderLineId, rem] of remaining) {
      if (rem > 0) resolved.push({ orderLineId, quantity: rem });
    }
    if (resolved.length === 0) {
      throw new CalderynError({
        code: "nothing_to_fulfil",
        status: 422,
        message: `Order ${input.orderId} has nothing left to fulfill.`,
      });
    }
  }

  // 5. Insert the fulfillment row. tracking_url stays null in phase 1 -- we never synthesize a
  // carrier tracking URL from a raw tracking number; that arrives with a later carrier-lookup slice.
  const fulfillmentIns = await sb
    .from("fulfillment")
    .insert({
      shop_id: shopId,
      order_id: input.orderId,
      status: "shipped",
      tracking_number: input.trackingNumber ?? null,
      carrier: input.carrier ?? null,
      tracking_url: null,
    })
    .select("id")
    .single();
  if (fulfillmentIns.error) throw fulfillmentIns.error;
  const fulfillmentId = String((fulfillmentIns.data as Record<string, unknown>).id);

  // 6. Insert the fulfillment_line rows.
  const flInsert = resolved.map((r) => ({
    shop_id: shopId,
    fulfillment_id: fulfillmentId,
    order_line_id: r.orderLineId,
    quantity: r.quantity,
  }));
  const flIns = await sb.from("fulfillment_line").insert(flInsert);
  if (flIns.error) throw flIns.error;

  // 7. Coverage -> target state. Skip transitionOrder on an identity move (a second partial
  // fulfillment of an already partially_fulfilled order records rows only).
  const afterRemaining = new Map(remaining);
  for (const r of resolved) {
    afterRemaining.set(r.orderLineId, (afterRemaining.get(r.orderLineId) ?? 0) - r.quantity);
  }
  const fullyCovered = [...afterRemaining.values()].every((v) => v <= 0);
  const targetState: OrderState = fullyCovered ? "fulfilled" : "partially_fulfilled";

  let orderState: OrderState = fromState;
  if (targetState !== fromState) {
    await transitionOrder(shopId, input.orderId, targetState, `fulfillment:${fulfillmentId}`);
    orderState = targetState;
  }

  // 8. Best-effort shipping-confirmation email; stamp notified_at only on a confirmed send.
  let notified = false;
  if (input.notify && buyerId) {
    const emailResult = await sendShippingConfirmation(shopId, input.orderId, {
      trackingNumber: input.trackingNumber ?? null,
      carrier: input.carrier ?? null,
    });
    notified = emailResult.sent;
    if (emailResult.sent) {
      const stampRes = await sb
        .from("fulfillment")
        .update({ notified_at: new Date().toISOString() })
        .eq("shop_id", shopId)
        .eq("id", fulfillmentId);
      if (stampRes.error) {
        // The email genuinely sent; a failure to stamp the timestamp must not fail the fulfillment
        // that already happened -- log loudly (rule 12) and move on.
        console.error(
          `[fulfill] shipping confirmation sent for order ${input.orderId} fulfillment ${fulfillmentId} but stamping notified_at failed`,
          stampRes.error,
        );
      }
    }
  }

  // 9. One append-only audit row + idempotency marker.
  const audit = await insertAuditWithIdempotency(
    shopId,
    input.idempotencyKey,
    {
      alert_id: null,
      action_kind: "fulfill_order",
      params: {
        orderId: input.orderId,
        lines: resolved,
        trackingNumber: input.trackingNumber ?? null,
        carrier: input.carrier ?? null,
        notify: input.notify,
      },
      outcome: "succeeded",
      pre_state: { state: fromState },
      post_state: { state: orderState, fulfillmentId },
      last_error: null,
      actor_user_id: input.actor ?? "merchant",
      write_target: "owned_sot",
    },
    sb,
  );

  const fulfilledUnits = resolved.reduce((sum, r) => sum + r.quantity, 0);

  return {
    auditId: audit.id,
    fulfillmentId,
    orderState,
    fulfilledUnits,
    notified,
    replayed: false,
  };
}
