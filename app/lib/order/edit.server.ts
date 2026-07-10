// app/lib/order/edit.server.ts
// Order editing (orders phase 3, Task 3): TWO independent flows that both mutate a native
// order's lines, gated on opposite ends of its lifecycle.
//
// 1. executeReduceLineAction — a PAID order's line can only shrink, never grow or get replaced.
//    order_line stays an immutable time-of-sale snapshot; a reduction is recorded as an
//    append-only order_line_edit row (old_quantity -> new_quantity), then a Stripe refund for the
//    exact delta is issued through the shared refund executor (a nested idempotency key keeps its
//    own audit/ledger trail independent of this action's), then an optional per-line restock.
//    Sibling to fulfill.server.ts / cancel.server.ts / actions/refund.server.ts: same
//    idempotency-key + append-only action_audit tail (action_kind 'edit_order', migration
//    20260710180000). Deliberately NOT added to actions/execute.server.ts's ExecutableKind —
//    'issue_refund' set the precedent that a bespoke order executor's action_kind need not also
//    be a generic campaign-action kind.
//
// 2. executeEditInvoiceLines — an UNPAID invoice (channel='invoice', state='checkout_pending')
//    has no money moved yet, so its lines are wholesale-replaceable: delete every order_line row
//    and re-insert fresh ones priced from the live catalog (priceLines — the same pricing path
//    cart/checkout/quotes share), then recompute totals (re-quoting shipping/tax through
//    quoteCart when the buyer has a default shipping address, mirroring sendDraftOrderInvoice).
//    The pay-link route (invoice.server.ts's payableInvoiceSession) always mints a Stripe session
//    from the order's CURRENT total_cents at click-time, so no Stripe-side work is needed here.
//
// CRASH WINDOW for executeReduceLineAction (rule 12): the steps below are several
// non-transactional PostgREST/RPC calls, not one atomic statement. If the order_line_edit row
// commits but the process dies before the action_audit tail lands, priorExecutionForKey (which
// only recognizes a COMPLETED action_audit row) sees nothing on retry — and by then
// effectiveLineQuantities already treats the crashed attempt's own edit row as this line's LATEST
// edit, so recomputing "currentEffective" from scratch would make the retry look like
// newQuantity >= currentEffective ("nothing to reduce"), silently dropping the resume instead of
// completing it. The fix: order_line_edit is keyed on the caller's idempotency_key (unique index,
// migration 20260710180000). Before doing any fresh validation, this executor checks for an
// EXISTING edit row under that key; if one exists, it trusts that row's already-committed
// old/new/refund_cents and resumes straight into the refund + restock + audit tail (both of which
// are independently idempotent on their own derived keys), instead of re-deriving anything from
// the current (already-mutated) state.
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "~/lib/supabase.server";
import { CalderynError } from "../calderyn.server";
import { priceLines } from "./cart.server";
import { effectiveLineQuantities } from "./line-edits.server";
import { isOrderState, type OrderState } from "./state";
import { loadDefaultShippingAddress } from "./detail.server";
import { priorExecutionForKey, insertAuditWithIdempotency } from "../actions/execute.server";
import { executeRefundAction } from "../actions/refund.server";
import { restockLine } from "../inventory/engine.server";
import { quoteCart } from "~/lib/commerce/quote.server";
import { ShipRestrictedError } from "~/lib/shipping/errors";

/** Order states a paid-line reduction may act on. `checkout_pending` has nothing captured to
 *  refund yet (that's executeEditInvoiceLines' territory); `cancelled`/`refunded` are terminal.
 *  `partially_refunded` MUST be included: the FIRST nonzero reduction on an order moves it to
 *  partially_refunded (via the nested executeRefundAction transition), so excluding it would
 *  permanently lock out every subsequent reduction — including the chained 5->3->1 case this
 *  module's contract requires. Over-refund on later reductions stays impossible regardless: the
 *  refund executor's ledger math (captured − refunded) and Stripe itself both cap it. */
const EDITABLE_STATES: ReadonlySet<OrderState> = new Set<OrderState>([
  "paid",
  "partially_fulfilled",
  "fulfilled",
  "partially_refunded",
]);

export interface ReduceLineActionInput {
  orderId: string;
  orderLineId: string;
  newQuantity: number;
  restock: boolean;
  reason?: string | null;
  actor?: string;
  idempotencyKey: string;
}

export interface ReduceLineActionResult {
  auditId: string;
  orderState: OrderState;
  refundedCents: number;
  restocked: boolean;
  /** Non-null when a restock was requested but failed — the refund/edit already committed. */
  restockError: string | null;
  replayed: boolean;
}

interface EditRow {
  id: string;
  oldQuantity: number;
  newQuantity: number;
  refundCents: number;
}

interface LineRow {
  id: string;
  variantId: string;
  unitPriceCents: number;
}

async function loadOrderState(sb: SupabaseClient, shopId: string, orderId: string): Promise<OrderState | null> {
  const { data, error } = await sb.from("orders").select("state").eq("shop_id", shopId).eq("id", orderId).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const state = String((data as Record<string, unknown>).state);
  return isOrderState(state) ? state : null;
}

async function loadLine(sb: SupabaseClient, shopId: string, orderId: string, orderLineId: string): Promise<LineRow> {
  const { data, error } = await sb
    .from("order_line")
    .select("id, variant_id, unit_price_cents")
    .eq("shop_id", shopId)
    .eq("order_id", orderId)
    .eq("id", orderLineId)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    throw new CalderynError({
      code: "line_not_found",
      status: 404,
      message: `Order line ${orderLineId} not found on order ${orderId}.`,
    });
  }
  const row = data as Record<string, unknown>;
  return { id: String(row.id), variantId: String(row.variant_id), unitPriceCents: Number(row.unit_price_cents ?? 0) };
}

async function loadFulfilledQtyForLine(sb: SupabaseClient, shopId: string, orderLineId: string): Promise<number> {
  const { data, error } = await sb.from("fulfillment_line").select("quantity").eq("shop_id", shopId).eq("order_line_id", orderLineId);
  if (error) throw error;
  return ((data ?? []) as Array<{ quantity: number }>).reduce((sum, r) => sum + Number(r.quantity ?? 0), 0);
}

/** Reconstruct a result from a prior COMPLETED audit row (the outer idempotency short-circuit). */
async function resultFromAudit(sb: SupabaseClient, shopId: string, auditId: string): Promise<ReduceLineActionResult> {
  const { data, error } = await sb.from("action_audit").select("id, params, post_state").eq("shop_id", shopId).eq("id", auditId).maybeSingle();
  if (error) throw error;
  const params = ((data?.params ?? {}) as Record<string, unknown>) ?? {};
  const post = ((data?.post_state ?? {}) as Record<string, unknown>) ?? {};
  const state = String(post.state ?? "paid");
  return {
    auditId,
    orderState: (isOrderState(state) ? state : "paid") as OrderState,
    refundedCents: Number(params.refunded_cents ?? 0),
    restocked: Boolean(params.restocked ?? false),
    restockError: params.restock_error ? String(params.restock_error) : null,
    replayed: true,
  };
}

export async function executeReduceLineAction(
  shopId: string,
  input: ReduceLineActionInput,
  sb: SupabaseClient = getSupabase(),
): Promise<ReduceLineActionResult> {
  if (!shopId) throw new Error("shopId is required");
  if (!input.orderId) throw new CalderynError({ code: "invalid_reduction", status: 422, message: "orderId is required." });
  if (!input.orderLineId) throw new CalderynError({ code: "invalid_reduction", status: 422, message: "orderLineId is required." });
  if (!input.idempotencyKey) throw new CalderynError({ code: "invalid_reduction", status: 422, message: "idempotencyKey is required." });
  if (!Number.isInteger(input.newQuantity) || input.newQuantity < 0) {
    throw new CalderynError({ code: "invalid_quantity", status: 422, message: "newQuantity must be a non-negative whole number." });
  }

  // 1. Outer idempotency: a completed execution under this key returns the SAME result.
  const prior = await priorExecutionForKey(shopId, input.idempotencyKey, sb);
  if (prior) return resultFromAudit(sb, shopId, prior.id);

  // 2. Crash-window resume check (module header): does an order_line_edit row already carry this
  //    exact idempotency_key? If so, a prior attempt got past the edit insert but never finished
  //    its audit tail — reuse its committed values instead of recomputing anything.
  const resumedRes = await sb
    .from("order_line_edit")
    .select("id, order_id, order_line_id, old_quantity, new_quantity, refund_cents")
    .eq("shop_id", shopId)
    .eq("idempotency_key", input.idempotencyKey)
    .maybeSingle();
  if (resumedRes.error) throw resumedRes.error;

  let editRow: EditRow;
  let line: LineRow | null = null;
  if (resumedRes.data) {
    const row = resumedRes.data as Record<string, unknown>;
    if (String(row.order_id) !== input.orderId || String(row.order_line_id) !== input.orderLineId) {
      // A caller-supplied idempotency key must be unique per (order, line) reduction. Two
      // different reductions colliding on the same key is a client bug, not a resumable state —
      // fail loudly rather than silently resuming the WRONG line's edit.
      throw new Error(
        `idempotency key ${input.idempotencyKey} is already bound to order ${row.order_id} line ${row.order_line_id}, not ${input.orderId}/${input.orderLineId}`,
      );
    }
    editRow = {
      id: String(row.id),
      oldQuantity: Number(row.old_quantity),
      newQuantity: Number(row.new_quantity),
      refundCents: Number(row.refund_cents),
    };
  } else {
    // 3. Fresh path: load + validate the order, the line, the currently-effective quantity, and
    //    what's already shipped, THEN insert the canonical edit row.
    const fromState = await loadOrderState(sb, shopId, input.orderId);
    if (!fromState) {
      throw new CalderynError({ code: "order_not_found", status: 404, message: `Order ${input.orderId} not found.` });
    }
    if (!EDITABLE_STATES.has(fromState)) {
      throw new CalderynError({
        code: "order_not_editable",
        status: 409,
        message: `Order ${input.orderId} is '${fromState}'; only a paid, partially-fulfilled, fulfilled, or partially-refunded order can have a line reduced.`,
      });
    }

    line = await loadLine(sb, shopId, input.orderId, input.orderLineId);
    const effectiveMap = await effectiveLineQuantities(shopId, input.orderId, sb);
    const eff = effectiveMap.get(input.orderLineId);
    if (!eff) {
      throw new CalderynError({ code: "line_not_found", status: 404, message: `Order line ${input.orderLineId} not found on order ${input.orderId}.` });
    }
    const currentEffective = eff.effective;
    const fulfilledQty = await loadFulfilledQtyForLine(sb, shopId, input.orderLineId);

    if (!(input.newQuantity < currentEffective)) {
      throw new CalderynError({
        code: "nothing_to_reduce",
        status: 422,
        message: `Order line ${input.orderLineId} is already at ${currentEffective}; ${input.newQuantity} is not a reduction.`,
      });
    }
    if (input.newQuantity < fulfilledQty) {
      throw new CalderynError({
        code: "below_fulfilled",
        status: 409,
        message: `Order line ${input.orderLineId} already shipped ${fulfilledQty}; cannot reduce below that.`,
      });
    }

    const delta = currentEffective - input.newQuantity;
    const refundCents = delta * line.unitPriceCents;

    const ins = await sb
      .from("order_line_edit")
      .insert({
        shop_id: shopId,
        order_id: input.orderId,
        order_line_id: input.orderLineId,
        old_quantity: currentEffective,
        new_quantity: input.newQuantity,
        refund_cents: refundCents,
        reason: input.reason ?? null,
        idempotency_key: input.idempotencyKey,
      })
      .select("id, old_quantity, new_quantity, refund_cents")
      .single();
    if (ins.error) {
      // Extremely narrow race: two concurrent requests bearing the SAME caller-supplied
      // idempotency key both passed the resume-detection SELECT above before either inserted.
      // The unique index on (shop_id, idempotency_key) lets exactly one insert win; the loser
      // reads back the winner's row rather than erroring the whole request.
      const code = (ins.error as { code?: string }).code;
      const isDup = code === "23505" || String(ins.error.message ?? "").includes("duplicate");
      if (!isDup) throw ins.error;
      const sel = await sb
        .from("order_line_edit")
        .select("id, old_quantity, new_quantity, refund_cents")
        .eq("shop_id", shopId)
        .eq("idempotency_key", input.idempotencyKey)
        .maybeSingle();
      if (sel.error) throw sel.error;
      if (!sel.data) throw ins.error;
      const row = sel.data as Record<string, unknown>;
      editRow = { id: String(row.id), oldQuantity: Number(row.old_quantity), newQuantity: Number(row.new_quantity), refundCents: Number(row.refund_cents) };
    } else {
      const row = ins.data as Record<string, unknown>;
      editRow = { id: String(row.id), oldQuantity: Number(row.old_quantity), newQuantity: Number(row.new_quantity), refundCents: Number(row.refund_cents) };
    }
  }

  // We need the line's variant for restock regardless of which branch produced editRow; the
  // resumed branch never loaded it above.
  if (!line) line = await loadLine(sb, shopId, input.orderId, input.orderLineId);

  // 4. Refund the exact reduction delta through the shared executor — its own nested idempotency
  //    key keeps its audit/ledger trail independent of (but linked to) this action's. A zero-price
  //    line (unit_price_cents === 0) has nothing to refund; executeRefundAction requires a
  //    positive amount, so skip the call rather than force a meaningless 0-cent refund attempt.
  let refundedCents = 0;
  let orderStateFromRefund: OrderState | null = null;
  if (editRow.refundCents > 0) {
    const refundResult = await executeRefundAction(
      shopId,
      {
        orderId: input.orderId,
        amountCents: editRow.refundCents,
        idempotencyKey: `${input.idempotencyKey}:refund`,
        actor: input.actor,
        reason: input.reason ?? "line reduction",
        restock: false, // restock is handled per-line below, not by the refund executor's whole-order path
      },
      sb,
    );
    refundedCents = refundResult.amountCents;
    orderStateFromRefund = refundResult.orderState;
  }

  // 5. Optional per-line restock — tracked variants only (an untracked line never held ledger
  //    stock, so restocking it would fabricate a balance row). Best-effort: the edit + refund
  //    already committed, so a restock failure is logged loudly and surfaced in the result/audit
  //    params rather than failing the whole action (mirrors refund.server.ts's restock stance).
  let restocked = false;
  let restockError: string | null = null;
  if (input.restock) {
    const qtyToRestock = editRow.oldQuantity - editRow.newQuantity;
    if (qtyToRestock > 0) {
      // The tracked-variant read sits INSIDE the best-effort try: money already moved, so even a
      // failed variant_dim read must degrade to a surfaced restockError, never throw past the
      // audit tail (a throw here would leave the action with no audit row and every retry
      // re-hitting the same error before ever reaching it).
      try {
        const variantRes = await sb.from("variant_dim").select("inventory_tracked").eq("shop_id", shopId).eq("id", line.variantId).maybeSingle();
        if (variantRes.error) throw variantRes.error;
        const tracked = (variantRes.data as Record<string, unknown> | null)?.inventory_tracked === true;
        if (tracked) {
          await restockLine(shopId, input.orderId, line.variantId, qtyToRestock, `editrestock:${editRow.id}`);
          restocked = true;
        }
        // else: untracked variant — silently skipped (recorded in audit params below, not an error).
      } catch (err) {
        restockError = err instanceof Error ? err.message : String(err);
        console.error(
          `[edit] order ${input.orderId} line ${input.orderLineId}: restock failed after the reduction+refund committed — reconcile inventory manually`,
          err,
        );
      }
    }
  }

  const orderState = orderStateFromRefund ?? (await loadOrderState(sb, shopId, input.orderId)) ?? "paid";

  // 6. One append-only action_audit row + idempotency marker.
  const audit = await insertAuditWithIdempotency(
    shopId,
    input.idempotencyKey,
    {
      alert_id: null,
      action_kind: "edit_order",
      params: {
        order_id: input.orderId,
        order_line_id: input.orderLineId,
        old_quantity: editRow.oldQuantity,
        new_quantity: editRow.newQuantity,
        refund_cents: editRow.refundCents,
        refunded_cents: refundedCents,
        restock_requested: input.restock,
        restocked,
        restock_error: restockError,
        reason: input.reason ?? null,
      },
      outcome: "succeeded",
      pre_state: { quantity: editRow.oldQuantity },
      post_state: { state: orderState, quantity: editRow.newQuantity },
      last_error: null,
      actor_user_id: input.actor ?? "merchant",
      write_target: "owned_sot",
    },
    sb,
  );

  return {
    auditId: audit.id,
    orderState,
    refundedCents,
    restocked,
    restockError,
    replayed: false,
  };
}

// ---------------------------------------------------------------------------
// Unpaid-invoice line edit (wholesale replace)
// ---------------------------------------------------------------------------

export interface EditInvoiceLineInput {
  variantId: string;
  quantity: number;
}

export interface EditInvoiceLinesResult {
  orderId: string;
  subtotalCents: number;
  shippingCents: number;
  taxCents: number;
  totalCents: number;
  currency: string;
}

const MIN_INVOICE_LINES = 1;
const MAX_INVOICE_LINES = 50;
const MIN_INVOICE_LINE_QTY = 1;
const MAX_INVOICE_LINE_QTY = 999;

/**
 * Replace every line on an unpaid invoice order (channel='invoice', state='checkout_pending')
 * wholesale: delete the current order_line rows, price+insert fresh ones from the LIVE catalog
 * (priceLines — the same path cart/checkout/quotes share, so an invoice edit can never diverge
 * from what a real checkout would charge), and recompute the order's money columns. Re-quotes
 * shipping/tax through quoteCart when the buyer has a default shipping address (mirrors
 * sendDraftOrderInvoice's guard); an invoice with no address on file keeps shipping/tax at 0,
 * same as when it was first sent. No Stripe work: the pay-link route always mints its session
 * from the order's CURRENT total_cents at click-time.
 */
export async function executeEditInvoiceLines(
  shopId: string,
  orderId: string,
  lines: EditInvoiceLineInput[],
  sb: SupabaseClient = getSupabase(),
): Promise<EditInvoiceLinesResult> {
  if (!shopId) throw new Error("shopId is required");
  if (!orderId) throw new CalderynError({ code: "invalid_edit", status: 422, message: "orderId is required." });
  if (!Array.isArray(lines) || lines.length < MIN_INVOICE_LINES || lines.length > MAX_INVOICE_LINES) {
    throw new CalderynError({
      code: "invalid_lines",
      status: 422,
      message: `lines must contain between ${MIN_INVOICE_LINES} and ${MAX_INVOICE_LINES} items.`,
    });
  }
  for (const l of lines) {
    if (!l.variantId) throw new CalderynError({ code: "invalid_lines", status: 422, message: "each line needs a variantId." });
    if (!Number.isInteger(l.quantity) || l.quantity < MIN_INVOICE_LINE_QTY || l.quantity > MAX_INVOICE_LINE_QTY) {
      throw new CalderynError({
        code: "invalid_lines",
        status: 422,
        message: `quantity for variant ${l.variantId} must be between ${MIN_INVOICE_LINE_QTY} and ${MAX_INVOICE_LINE_QTY}.`,
      });
    }
  }

  const orderRes = await sb.from("orders").select("id, channel, state, buyer_id").eq("shop_id", shopId).eq("id", orderId).maybeSingle();
  if (orderRes.error) throw orderRes.error;
  const order = orderRes.data as Record<string, unknown> | null;
  if (!order) throw new CalderynError({ code: "order_not_found", status: 404, message: `Order ${orderId} not found.` });
  if (order.channel !== "invoice" || order.state !== "checkout_pending") {
    throw new CalderynError({
      code: "not_editable_invoice",
      status: 409,
      message: `Order ${orderId} is not an unpaid invoice (channel=${String(order.channel)}, state=${String(order.state)}); only a pending invoice's lines can be edited.`,
    });
  }

  const priced = await priceLines(shopId, lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })));

  let shippingCents = 0;
  let taxCents = 0;
  const buyerId = order.buyer_id == null ? null : String(order.buyer_id);
  if (buyerId) {
    const address = await loadDefaultShippingAddress(sb, shopId, buyerId);
    // Mirrors sendDraftOrderInvoice's guard: an address with a blank street can't be quoted
    // (quoteCart surfaces an opaque carrier error) — treat it like no address (0/0).
    if (address && address.line1) {
      let quoted;
      try {
        quoted = await quoteCart(
          shopId,
          priced.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })),
          {
            street1: address.line1 ?? "",
            street2: address.line2 ?? undefined,
            city: address.city ?? "",
            state: address.region ?? "",
            zip: address.postal ?? "",
            country: address.country ?? "US",
          },
          { subtotalCentsOverride: priced.subtotalCents },
        );
      } catch (err) {
        // A destination-restricted item is an actionable merchant error, not an internal one —
        // translate it to a typed 422 (the same treatment storefront checkout gives it) instead
        // of letting a plain-Error subclass fall through dashboardJson as an opaque 500.
        if (err instanceof ShipRestrictedError) {
          throw new CalderynError({ code: "ship_restricted", status: 422, message: err.message });
        }
        throw err;
      }
      shippingCents = quoted.shippingCents;
      taxCents = quoted.taxCents;
    }
  }
  const totalCents = priced.subtotalCents + shippingCents + taxCents;

  const del = await sb.from("order_line").delete().eq("shop_id", shopId).eq("order_id", orderId);
  if (del.error) throw del.error;

  const lineRows = priced.lines.map((l) => ({
    shop_id: shopId,
    order_id: orderId,
    variant_id: l.variantId,
    quantity: l.quantity,
    unit_price_cents: l.unitPriceCents,
    title_snapshot: l.titleSnapshot,
  }));
  const ins = await sb.from("order_line").insert(lineRows);
  if (ins.error) throw ins.error;

  const upd = await sb
    .from("orders")
    .update({
      subtotal_cents: priced.subtotalCents,
      shipping_cents: shippingCents,
      tax_cents: taxCents,
      total_cents: totalCents,
      currency: priced.currency,
    })
    .eq("shop_id", shopId)
    .eq("id", orderId);
  if (upd.error) throw upd.error;

  return { orderId, subtotalCents: priced.subtotalCents, shippingCents, taxCents, totalCents, currency: priced.currency };
}
