// app/lib/order/returns.server.ts
// Merchant-recorded returns (orders Phase 4, Task 1): the RMA spine. Follows the edit-executor
// discipline exactly (edit.server.ts / refund.server.ts / cancel.server.ts) — idempotency lanes,
// crash-window resume, over-refund pre-check BEFORE any write, CAS status flips, one append-only
// action_audit tail.
//
// A return has two phases, each a separate executor:
//   1. createOrderReturn — merchant records what's coming back (open). Validates the order is
//      native + in a returnable state, per-line quantity is within fulfilled-minus-already-received,
//      and any client-supplied refund_cents does not exceed the server-computed default (unit price
//      x qty + a proportional tax share, mirroring edit.server.ts's reduction-tax formula exactly —
//      both derive a refund from a quantity delta against the order's captured subtotal/tax).
//   2. executeReturnReceivedAction — the merchant confirms the item physically arrived: restocks
//      each requested line (tracked variants only, best-effort like every other restock path in this
//      module family), refunds the return's total (delegated to actions/refund.server.ts with a
//      nested idempotency key, same pattern edit.server.ts's nested refund uses), then flips the
//      return open -> closed in one CAS update, stamping received_at + the caller's idempotency key.
//
// CRASH WINDOW (rule 12, same shape as edit.server.ts's header): executeReturnReceivedAction's steps
// are several non-transactional PostgREST/RPC calls. A crash AFTER the restock/refund commit but
// BEFORE the outer action_audit row lands would otherwise make a retry either 409 (the CAS guard
// sees a non-open status) or re-run the over-refund pre-check against a ledger the retry's OWN prior
// attempt already moved — a false rejection when the original refund exactly exhausted what was
// refundable. The fix mirrors order_line_edit's idempotency_key column: order_return carries its own
// received_idempotency_key, stamped atomically with the status flip. A retry that finds the return
// already non-open BUT carrying ITS OWN idempotency key on that column is a proven resume, not a
// conflict — it skips the (now potentially stale) over-refund pre-check and re-enters restock/refund,
// both of which are independently idempotent (restock keyed per return-line row id; the refund
// delegate replays via its own nested idempotency key), then writes the missing audit tail.
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "~/lib/supabase.server";
import { CalderynError } from "../calderyn.server";
import { isOrderState, type OrderState } from "./state";
import { priorExecutionForKey, insertAuditWithIdempotency } from "../actions/execute.server";
import { executeRefundAction } from "../actions/refund.server";
import { restockLine } from "../inventory/engine.server";
import { remainingRefundableByOrder } from "./list.server";
import type { OrderReturn, OrderReturnLine } from "./returns-types";

/** Order states a return may be opened against — identical to edit.server.ts's EDITABLE_STATES:
 *  a return only makes sense once something has shipped (or the order otherwise carries captured
 *  money to refund), and checkout_pending/cart/cancelled/refunded have nothing to return against. */
const RETURNABLE_STATES: ReadonlySet<OrderState> = new Set<OrderState>([
  "paid",
  "partially_fulfilled",
  "fulfilled",
  "partially_refunded",
]);

/** A completed return's lines count against a line's returnable quantity forever after — 'received'
 *  is the reserved future-async status (see returns-types.ts); 'closed' is what v1's receive flow
 *  actually persists. 'cancelled'/'open' returns never consumed any returnable quantity. */
const COMPLETED_RETURN_STATUSES = new Set(["received", "closed"]);

// ---------------------------------------------------------------------------
// Shared read helpers
// ---------------------------------------------------------------------------

interface OrderMoneyRow {
  state: OrderState;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
}

async function loadOrderForReturn(sb: SupabaseClient, shopId: string, orderId: string): Promise<OrderMoneyRow | null> {
  const { data, error } = await sb
    .from("orders")
    .select("state, subtotal_cents, tax_cents, total_cents")
    .eq("shop_id", shopId)
    .eq("id", orderId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as Record<string, unknown>;
  const state = String(row.state);
  if (!isOrderState(state)) return null;
  return {
    state,
    subtotalCents: Number(row.subtotal_cents ?? 0),
    taxCents: Number(row.tax_cents ?? 0),
    totalCents: Number(row.total_cents ?? 0),
  };
}

interface OrderLineRow {
  id: string;
  variantId: string;
  unitPriceCents: number;
}

/** Order lines requested by a create call, keyed by id — batched in one shop+order-scoped read. */
async function loadOrderLines(
  sb: SupabaseClient,
  shopId: string,
  orderId: string,
  lineIds: string[],
): Promise<Map<string, OrderLineRow>> {
  const map = new Map<string, OrderLineRow>();
  if (lineIds.length === 0) return map;
  const { data, error } = await sb
    .from("order_line")
    .select("id, variant_id, unit_price_cents")
    .eq("shop_id", shopId)
    .eq("order_id", orderId)
    .in("id", lineIds);
  if (error) throw error;
  for (const r of (data ?? []) as Record<string, unknown>[]) {
    map.set(String(r.id), {
      id: String(r.id),
      variantId: String(r.variant_id),
      unitPriceCents: Number(r.unit_price_cents ?? 0),
    });
  }
  return map;
}

/** Units actually shipped per order_line, summed across every fulfillment on the order — same
 *  two-step (fulfillment ids -> fulfillment_line) shape fulfill.server.ts's remaining-to-ship read
 *  uses, batched for every line on the order at once rather than one line at a time. */
async function loadFulfilledQtyByLine(sb: SupabaseClient, shopId: string, orderId: string): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  const fulfillmentsRes = await sb.from("fulfillment").select("id").eq("shop_id", shopId).eq("order_id", orderId);
  if (fulfillmentsRes.error) throw fulfillmentsRes.error;
  const fulfillmentIds = ((fulfillmentsRes.data ?? []) as Array<{ id: string }>).map((f) => String(f.id));
  if (fulfillmentIds.length === 0) return map;
  const flRes = await sb
    .from("fulfillment_line")
    .select("order_line_id, quantity")
    .eq("shop_id", shopId)
    .in("fulfillment_id", fulfillmentIds);
  if (flRes.error) throw flRes.error;
  for (const r of (flRes.data ?? []) as Array<{ order_line_id: string; quantity: number }>) {
    const id = String(r.order_line_id);
    map.set(id, (map.get(id) ?? 0) + Number(r.quantity ?? 0));
  }
  return map;
}

/** Units already consumed by a COMPLETED return (received/closed) per order_line, across every
 *  return on the order except `excludeReturnId` (this return's own lines, when re-validating at
 *  receive time — otherwise a return would count its own not-yet-completed quantity against itself). */
async function loadReceivedReturnQtyByLine(
  sb: SupabaseClient,
  shopId: string,
  orderId: string,
  excludeReturnId?: string,
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  const returnsRes = await sb.from("order_return").select("id, status").eq("shop_id", shopId).eq("order_id", orderId);
  if (returnsRes.error) throw returnsRes.error;
  const returnIds = ((returnsRes.data ?? []) as Array<{ id: string; status: string }>)
    .filter((r) => COMPLETED_RETURN_STATUSES.has(String(r.status)) && String(r.id) !== excludeReturnId)
    .map((r) => String(r.id));
  if (returnIds.length === 0) return map;
  const linesRes = await sb
    .from("order_return_line")
    .select("order_line_id, quantity")
    .eq("shop_id", shopId)
    .in("return_id", returnIds);
  if (linesRes.error) throw linesRes.error;
  for (const r of (linesRes.data ?? []) as Array<{ order_line_id: string; quantity: number }>) {
    const id = String(r.order_line_id);
    map.set(id, (map.get(id) ?? 0) + Number(r.quantity ?? 0));
  }
  return map;
}

// ---------------------------------------------------------------------------
// createOrderReturn
// ---------------------------------------------------------------------------

export interface CreateReturnLineInput {
  orderLineId: string;
  quantity: number;
  restock: boolean;
  /** Omit to use the server-computed default (unit price x qty + proportional tax share). When
   *  supplied, it may not exceed that default — a merchant can refund LESS than face value (e.g. a
   *  restocking fee) but never manufacture a refund bigger than what was actually paid for the line. */
  refundCents?: number;
}

export interface CreateOrderReturnInput {
  orderId: string;
  lines: CreateReturnLineInput[];
  reason?: string | null;
}

export interface CreateOrderReturnResultLine {
  id: string;
  orderLineId: string;
  quantity: number;
  restock: boolean;
  refundCents: number;
}

export interface CreateOrderReturnResult {
  returnId: string;
  status: "open";
  lines: CreateOrderReturnResultLine[];
}

export async function createOrderReturn(
  shopId: string,
  input: CreateOrderReturnInput,
  sb: SupabaseClient = getSupabase(),
): Promise<CreateOrderReturnResult> {
  if (!shopId) throw new Error("shopId is required");
  if (!input.orderId) {
    throw new CalderynError({ code: "invalid_return", status: 422, message: "orderId is required." });
  }
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw new CalderynError({ code: "invalid_lines", status: 422, message: "At least one return line is required." });
  }
  const seenLineIds = new Set<string>();
  for (const l of input.lines) {
    if (!l.orderLineId) {
      throw new CalderynError({ code: "invalid_lines", status: 422, message: "each line needs an orderLineId." });
    }
    if (seenLineIds.has(l.orderLineId)) {
      throw new CalderynError({
        code: "duplicate_line",
        status: 422,
        message: `Order line ${l.orderLineId} is requested more than once in the same return.`,
      });
    }
    seenLineIds.add(l.orderLineId);
    if (!Number.isInteger(l.quantity) || l.quantity <= 0) {
      throw new CalderynError({
        code: "invalid_quantity",
        status: 422,
        message: `Order line ${l.orderLineId} quantity must be a positive whole number (got ${l.quantity}).`,
      });
    }
    if (l.refundCents !== undefined && (!Number.isInteger(l.refundCents) || l.refundCents < 0)) {
      throw new CalderynError({
        code: "invalid_refund",
        status: 422,
        message: `Order line ${l.orderLineId} refundCents must be a non-negative whole number.`,
      });
    }
  }

  const order = await loadOrderForReturn(sb, shopId, input.orderId);
  if (!order) {
    throw new CalderynError({ code: "order_not_found", status: 404, message: `Order ${input.orderId} not found.` });
  }
  if (!RETURNABLE_STATES.has(order.state)) {
    throw new CalderynError({
      code: "order_not_returnable",
      status: 409,
      message: `Order ${input.orderId} is '${order.state}'; only a paid, partially-fulfilled, fulfilled, or partially-refunded order can have a return created.`,
    });
  }

  const lineIds = input.lines.map((l) => l.orderLineId);
  const [orderLines, fulfilledByLine, receivedByLine] = await Promise.all([
    loadOrderLines(sb, shopId, input.orderId, lineIds),
    loadFulfilledQtyByLine(sb, shopId, input.orderId),
    loadReceivedReturnQtyByLine(sb, shopId, input.orderId),
  ]);

  const linesToInsert: Array<{ order_line_id: string; quantity: number; restock: boolean; refund_cents: number }> = [];
  for (const l of input.lines) {
    const line = orderLines.get(l.orderLineId);
    if (!line) {
      throw new CalderynError({
        code: "line_not_found",
        status: 404,
        message: `Order line ${l.orderLineId} not found on order ${input.orderId}.`,
      });
    }
    const fulfilled = fulfilledByLine.get(l.orderLineId) ?? 0;
    const alreadyReceived = receivedByLine.get(l.orderLineId) ?? 0;
    const returnable = fulfilled - alreadyReceived;
    if (l.quantity > returnable) {
      throw new CalderynError({
        code: "qty_exceeds_returnable",
        status: 409,
        message: `Order line ${l.orderLineId} has ${returnable} unit(s) returnable; cannot return ${l.quantity}.`,
      });
    }

    // Default refund: unit price x qty, plus this quantity's proportional share of the order's
    // captured tax — the EXACT same formula edit.server.ts's reduction refund uses (both derive a
    // refund from a quantity delta against the order-level subtotal/tax captured at time of sale).
    const deltaSubtotal = l.quantity * line.unitPriceCents;
    const taxShare = order.subtotalCents > 0 ? Math.floor((order.taxCents * deltaSubtotal) / order.subtotalCents) : 0;
    const defaultRefundCents = deltaSubtotal + taxShare;
    const refundCents = l.refundCents ?? defaultRefundCents;
    if (refundCents > defaultRefundCents) {
      throw new CalderynError({
        code: "refund_exceeds_default",
        status: 422,
        message: `Order line ${l.orderLineId} refund ${refundCents} exceeds the default ${defaultRefundCents}.`,
      });
    }

    linesToInsert.push({ order_line_id: l.orderLineId, quantity: l.quantity, restock: l.restock, refund_cents: refundCents });
  }

  const returnIns = await sb
    .from("order_return")
    .insert({ shop_id: shopId, order_id: input.orderId, status: "open", reason: input.reason ?? null })
    .select("id")
    .single();
  if (returnIns.error) {
    // The one-open-return partial unique index (order_return_one_open) rejects a second `open`
    // return for this order at the database — surface it as a typed 409 rather than an opaque 500.
    const code = (returnIns.error as { code?: string }).code;
    const isDup = code === "23505" || String(returnIns.error.message ?? "").includes("duplicate");
    if (isDup) {
      throw new CalderynError({
        code: "return_already_open",
        status: 409,
        message: `Order ${input.orderId} already has an open return.`,
      });
    }
    throw returnIns.error;
  }
  const returnId = String((returnIns.data as Record<string, unknown>).id);

  const lineRows = linesToInsert.map((l) => ({
    shop_id: shopId,
    return_id: returnId,
    order_line_id: l.order_line_id,
    quantity: l.quantity,
    restock: l.restock,
    refund_cents: l.refund_cents,
  }));
  const lineIns = await sb
    .from("order_return_line")
    .insert(lineRows)
    .select("id, order_line_id, quantity, restock, refund_cents");
  if (lineIns.error) throw lineIns.error;

  const resultLines: CreateOrderReturnResultLine[] = ((lineIns.data ?? []) as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    orderLineId: String(r.order_line_id),
    quantity: Number(r.quantity),
    restock: Boolean(r.restock),
    refundCents: Number(r.refund_cents),
  }));

  return { returnId, status: "open", lines: resultLines };
}

// ---------------------------------------------------------------------------
// cancelOrderReturn
// ---------------------------------------------------------------------------

export interface CancelOrderReturnResult {
  returnId: string;
  status: "cancelled";
}

export async function cancelOrderReturn(
  shopId: string,
  returnId: string,
  sb: SupabaseClient = getSupabase(),
): Promise<CancelOrderReturnResult> {
  if (!shopId) throw new Error("shopId is required");
  if (!returnId) {
    throw new CalderynError({ code: "invalid_return", status: 422, message: "returnId is required." });
  }

  // Atomic CAS claim (mirrors invoice.server.ts's draft-cart claim): only a currently-`open` return
  // flips to `cancelled`. Zero rows matched means either no such return, or one that already moved
  // on (received/closed/cancelled) — a follow-up read distinguishes the two for the right error.
  const upd = await sb
    .from("order_return")
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .eq("shop_id", shopId)
    .eq("id", returnId)
    .eq("status", "open")
    .select("id");
  if (upd.error) throw upd.error;
  if (!upd.data || (Array.isArray(upd.data) && upd.data.length === 0)) {
    const existing = await sb.from("order_return").select("id, status").eq("shop_id", shopId).eq("id", returnId).maybeSingle();
    if (existing.error) throw existing.error;
    const row = existing.data as Record<string, unknown> | null;
    if (!row) {
      throw new CalderynError({ code: "return_not_found", status: 404, message: `Return ${returnId} not found.` });
    }
    throw new CalderynError({
      code: "return_not_cancellable",
      status: 409,
      message: `Return ${returnId} is '${String(row.status)}'; only an open return can be cancelled.`,
    });
  }

  return { returnId, status: "cancelled" };
}

// ---------------------------------------------------------------------------
// executeReturnReceivedAction
// ---------------------------------------------------------------------------

export interface ReturnReceivedActionInput {
  returnId: string;
  idempotencyKey: string;
  actor?: string;
}

export interface ReturnReceivedActionResult {
  auditId: string;
  returnId: string;
  orderId: string;
  status: "closed";
  refundedCents: number;
  /** Count of return lines successfully restocked (tracked variants only, restock=true). */
  restockedLines: number;
  /** Non-null when at least one line's restock failed — the refund/close already committed. */
  restockErrors: string[] | null;
  replayed: boolean;
}

interface ReturnRow {
  id: string;
  orderId: string;
  status: string;
  receivedIdempotencyKey: string | null;
}

async function loadReturn(sb: SupabaseClient, shopId: string, returnId: string): Promise<ReturnRow | null> {
  const { data, error } = await sb
    .from("order_return")
    .select("id, order_id, status, received_idempotency_key")
    .eq("shop_id", shopId)
    .eq("id", returnId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as Record<string, unknown>;
  return {
    id: String(row.id),
    orderId: String(row.order_id),
    status: String(row.status),
    receivedIdempotencyKey: row.received_idempotency_key == null ? null : String(row.received_idempotency_key),
  };
}

interface ReturnLineRow {
  id: string;
  orderLineId: string;
  quantity: number;
  restock: boolean;
  refundCents: number;
}

async function loadReturnLines(sb: SupabaseClient, shopId: string, returnId: string): Promise<ReturnLineRow[]> {
  const { data, error } = await sb
    .from("order_return_line")
    .select("id, order_line_id, quantity, restock, refund_cents")
    .eq("shop_id", shopId)
    .eq("return_id", returnId);
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    orderLineId: String(r.order_line_id),
    quantity: Number(r.quantity),
    restock: Boolean(r.restock),
    refundCents: Number(r.refund_cents ?? 0),
  }));
}

/** Reconstruct a result from a prior COMPLETED audit row (the outer idempotency short-circuit). */
async function resultFromAudit(sb: SupabaseClient, shopId: string, auditId: string): Promise<ReturnReceivedActionResult> {
  const { data, error } = await sb.from("action_audit").select("id, params").eq("shop_id", shopId).eq("id", auditId).maybeSingle();
  if (error) throw error;
  const params = ((data?.params ?? {}) as Record<string, unknown>) ?? {};
  return {
    auditId,
    returnId: params.return_id ? String(params.return_id) : "",
    orderId: params.order_id ? String(params.order_id) : "",
    status: "closed",
    refundedCents: Number(params.refunded_cents ?? 0),
    restockedLines: Number(params.restocked_lines ?? 0),
    restockErrors: Array.isArray(params.restock_errors) ? (params.restock_errors as string[]) : null,
    replayed: true,
  };
}

/** Per-line, best-effort restock (tracked variants only) — mirrors edit.server.ts's restock stance:
 *  the refund/close already committed by the time this could fail, so a failure is logged loudly
 *  and surfaced in the result/audit params, never thrown past the audit tail. Keyed
 *  `restockreturn:<order_return_line id>` — one row, one restock, naturally idempotent on replay. */
async function restockReturnLines(
  sb: SupabaseClient,
  shopId: string,
  orderId: string,
  lines: ReturnLineRow[],
): Promise<{ restockedLines: number; restockErrors: string[] }> {
  let restockedLines = 0;
  const restockErrors: string[] = [];
  for (const line of lines) {
    if (!line.restock || line.quantity <= 0) continue;
    try {
      const olRes = await sb.from("order_line").select("variant_id").eq("shop_id", shopId).eq("id", line.orderLineId).maybeSingle();
      if (olRes.error) throw olRes.error;
      const variantId = (olRes.data as Record<string, unknown> | null)?.variant_id;
      if (!variantId) continue; // order_line vanished (shouldn't happen given the FK) — nothing to restock.
      const variantRes = await sb.from("variant_dim").select("inventory_tracked").eq("shop_id", shopId).eq("id", String(variantId)).maybeSingle();
      if (variantRes.error) throw variantRes.error;
      const tracked = (variantRes.data as Record<string, unknown> | null)?.inventory_tracked === true;
      if (!tracked) continue; // untracked variant never held ledger stock — silently skipped, not an error.
      await restockLine(shopId, orderId, String(variantId), line.quantity, `restockreturn:${line.id}`);
      restockedLines += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      restockErrors.push(`${line.id}: ${message}`);
      console.error(
        `[returns] order ${orderId} return line ${line.id}: restock failed after the return committed — reconcile inventory manually`,
        err,
      );
    }
  }
  return { restockedLines, restockErrors };
}

/**
 * Mark a return received: restock requested lines (best-effort, tracked-only), refund the return's
 * total (delegated to actions/refund.server.ts, skipped entirely when the total is 0), flip the
 * return open -> closed (CAS, tolerant of a concurrent retry already having flipped it), and audit.
 *
 * Binding flow (see module header for the crash-window rationale): replay via priorExecutionForKey
 * -> load return + lines (+ order, for the over-refund fallback) -> resume-or-validate -> per-line
 * restock -> refund the line total when > 0 -> CAS status flip -> one action_audit row.
 */
export async function executeReturnReceivedAction(
  shopId: string,
  input: ReturnReceivedActionInput,
  sb: SupabaseClient = getSupabase(),
): Promise<ReturnReceivedActionResult> {
  if (!shopId) throw new Error("shopId is required");
  if (!input.returnId) {
    throw new CalderynError({ code: "invalid_return_received", status: 422, message: "returnId is required." });
  }
  if (!input.idempotencyKey) {
    throw new CalderynError({ code: "invalid_return_received", status: 422, message: "idempotencyKey is required." });
  }

  // 1. Outer idempotency: a completed execution under this key returns the SAME result.
  const prior = await priorExecutionForKey(shopId, input.idempotencyKey, sb);
  if (prior) return resultFromAudit(sb, shopId, prior.id);

  // 2. Load the return + its lines.
  const ret = await loadReturn(sb, shopId, input.returnId);
  if (!ret) {
    throw new CalderynError({ code: "return_not_found", status: 404, message: `Return ${input.returnId} not found.` });
  }
  const lines = await loadReturnLines(sb, shopId, ret.id);

  // 3. Crash-window resume check (module header): this exact idempotency key already stamped
  //    received_idempotency_key at the same time it flipped the row non-open, but the outer audit
  //    tail never landed. Resume straight into restock/refund (both independently idempotent) and
  //    skip the (now potentially stale, given the ledger already reflects the earlier refund)
  //    over-refund pre-check, rather than re-deriving it from the current state.
  const isResume = ret.status !== "open" && ret.receivedIdempotencyKey === input.idempotencyKey;
  if (!isResume && ret.status !== "open") {
    throw new CalderynError({
      code: "return_not_open",
      status: 409,
      message: `Return ${input.returnId} is '${ret.status}'; only an open return can be marked received.`,
    });
  }

  const totalRefundCents = lines.reduce((sum, l) => sum + l.refundCents, 0);

  if (!isResume) {
    // 3a. Re-validate quantities against fulfilled - received (excluding this return's own,
    //     still-open lines) — cheap insurance alongside the one-open-return guard (key decisions).
    const [fulfilledByLine, receivedByLine] = await Promise.all([
      loadFulfilledQtyByLine(sb, shopId, ret.orderId),
      loadReceivedReturnQtyByLine(sb, shopId, ret.orderId, ret.id),
    ]);
    for (const line of lines) {
      const returnable = (fulfilledByLine.get(line.orderLineId) ?? 0) - (receivedByLine.get(line.orderLineId) ?? 0);
      if (line.quantity > returnable) {
        throw new CalderynError({
          code: "qty_exceeds_returnable",
          status: 409,
          message: `Order line ${line.orderLineId} has ${returnable} unit(s) returnable; return ${input.returnId} requests ${line.quantity}.`,
        });
      }
    }

    // 3b. Over-refund pre-check BEFORE any write (fix I1's pattern, edit.server.ts): the refund
    //     this return would issue must not exceed what remains refundable on the order.
    const order = await loadOrderForReturn(sb, shopId, ret.orderId);
    const remainingMap = await remainingRefundableByOrder(shopId, [ret.orderId]);
    const remainingRefundableCents = remainingMap.get(ret.orderId) ?? order?.totalCents ?? 0;
    if (totalRefundCents > remainingRefundableCents) {
      throw new CalderynError({
        code: "over_refund",
        status: 409,
        message: `Receiving return ${input.returnId} would refund ${totalRefundCents} cents, but only ${remainingRefundableCents} cents remain refundable on order ${ret.orderId}.`,
      });
    }
  }

  // 4. Per-line restock (tracked only, best-effort — see restockReturnLines's own header).
  const { restockedLines, restockErrors } = await restockReturnLines(sb, shopId, ret.orderId, lines);

  // 5. Refund the return's total via the shared executor, nested idempotency key. Skipped entirely
  //    when the total is 0 (e.g. every line refunds $0 — a restocking-fee-only return) — mirrors
  //    edit.server.ts's zero-price-line skip.
  let refundedCents = 0;
  if (totalRefundCents > 0) {
    const refundResult = await executeRefundAction(
      shopId,
      {
        orderId: ret.orderId,
        amountCents: totalRefundCents,
        idempotencyKey: `${input.idempotencyKey}:refund`,
        actor: input.actor,
        reason: "return received",
        restock: false, // restock is handled per-line above, not by the refund executor's whole-order path
      },
      sb,
    );
    refundedCents = refundResult.amountCents;
  }

  // 6. CAS status flip: open -> closed, stamping received_at + this key. Tolerant of 0 rows matched
  //    (module header: a concurrent execution of this SAME key already flipped it) — the restock and
  //    refund above are each independently idempotent, so there is nothing left to redo either way.
  const nowIso = new Date().toISOString();
  const stampUpd = await sb
    .from("order_return")
    .update({ status: "closed", received_at: nowIso, received_idempotency_key: input.idempotencyKey, updated_at: nowIso })
    .eq("shop_id", shopId)
    .eq("id", ret.id)
    .eq("status", "open")
    .select("id");
  if (stampUpd.error) throw stampUpd.error;

  // 7. One append-only action_audit row + idempotency marker.
  const audit = await insertAuditWithIdempotency(
    shopId,
    input.idempotencyKey,
    {
      alert_id: null,
      action_kind: "return_received",
      params: {
        return_id: ret.id,
        order_id: ret.orderId,
        refunded_cents: refundedCents,
        restocked_lines: restockedLines,
        restock_errors: restockErrors.length > 0 ? restockErrors : null,
      },
      outcome: "succeeded",
      pre_state: { status: ret.status },
      post_state: { status: "closed" },
      last_error: null,
      actor_user_id: input.actor ?? "merchant",
      write_target: "owned_sot",
    },
    sb,
  );

  return {
    auditId: audit.id,
    returnId: ret.id,
    orderId: ret.orderId,
    status: "closed",
    refundedCents,
    restockedLines,
    restockErrors: restockErrors.length > 0 ? restockErrors : null,
    replayed: false,
  };
}

// ---------------------------------------------------------------------------
// listOrderReturns
// ---------------------------------------------------------------------------

/** Every return recorded against an order, newest first, with its lines. Used by detail.server.ts
 *  to populate the OrderDetail DTO's `returns` field (native branch only — imported orders never
 *  went through this spine). */
export async function listOrderReturns(
  shopId: string,
  orderId: string,
  sb: SupabaseClient = getSupabase(),
): Promise<OrderReturn[]> {
  if (!shopId) throw new Error("shopId is required");
  if (!orderId) return [];

  const returnsRes = await sb
    .from("order_return")
    .select("id, status, reason, created_at, received_at")
    .eq("shop_id", shopId)
    .eq("order_id", orderId);
  if (returnsRes.error) throw returnsRes.error;
  const returns = (returnsRes.data ?? []) as Record<string, unknown>[];
  if (returns.length === 0) return [];

  const returnIds = returns.map((r) => String(r.id));
  const linesRes = await sb
    .from("order_return_line")
    .select("id, return_id, order_line_id, quantity, restock, refund_cents")
    .eq("shop_id", shopId)
    .in("return_id", returnIds);
  if (linesRes.error) throw linesRes.error;

  const linesByReturn = new Map<string, OrderReturnLine[]>();
  for (const r of (linesRes.data ?? []) as Record<string, unknown>[]) {
    const rid = String(r.return_id);
    const arr = linesByReturn.get(rid) ?? [];
    arr.push({
      id: String(r.id),
      orderLineId: String(r.order_line_id),
      quantity: Number(r.quantity),
      restock: Boolean(r.restock),
      refundCents: Number(r.refund_cents),
    });
    linesByReturn.set(rid, arr);
  }

  return returns
    .map((r) => ({
      id: String(r.id),
      orderId,
      status: String(r.status) as OrderReturn["status"],
      reason: r.reason == null ? null : String(r.reason),
      createdAt: String(r.created_at),
      receivedAt: r.received_at == null ? null : String(r.received_at),
      lines: linesByReturn.get(String(r.id)) ?? [],
    }))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}
