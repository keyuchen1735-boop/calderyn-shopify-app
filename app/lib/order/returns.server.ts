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
//   2. executeReturnReceivedAction — the merchant confirms the item physically arrived: refunds the
//      return's total FIRST (delegated to actions/refund.server.ts with a nested idempotency key,
//      same pattern edit.server.ts's nested refund uses) so a refund failure can never strand a
//      committed restock behind a return that's still open and cancellable; THEN restocks each
//      requested line (tracked variants only, best-effort like every other restock path in this
//      module family — a restock failure at this point is the already-tolerated surfaced path,
//      logged and reported in the result/audit params rather than thrown, mirroring
//      edit.server.ts's own restock-after-refund stance); then flips the return open -> closed in
//      one CAS update, stamping received_at + the caller's idempotency key.
//
// CRASH WINDOW (rule 12, same shape as edit.server.ts's header): executeReturnReceivedAction's steps
// are several non-transactional PostgREST/RPC calls, so a crash between any two of them must not
// turn a safe retry into either a false over_refund 409 or a lost audit tail. Two separate windows,
// two separate detectors:
//   - Refund committed, flip not yet reached (anywhere between the nested refund call and the CAS
//     status flip below — which now includes the restock step, since refund runs BEFORE restock):
//     status is still 'open' and received_idempotency_key is still null, so a naive retry falls
//     into the FRESH branch and re-runs the over-refund pre-check against a ledger that already
//     reflects THIS return's own prior refund — a false, permanent over_refund 409 (money moved,
//     return stuck open forever, the one-open-return index blocking any new return on the order).
//     Detected by a proven `<idempotencyKey>:refund` execution FOR THIS ORDER (mirrors
//     cancel.server.ts's priorRefundBelongsToThisOrder — action_kind + outcome + params.order_id,
//     not a literal sub-key match alone, since idempotency keys are caller-supplied strings). Once
//     proven, the resume skips the pre-check AND the refund call (already done, amount taken from
//     the verified prior execution) and re-runs the per-line restocks (idempotent — a crash mid-
//     restock on the FIRST attempt just means some lines restock again here, harmlessly, since each
//     restock is keyed per return-line row id), then the CAS flip + audit tail as normal. A
//     zero-refund return never reaches the refund call in the first place, so its crash resumes
//     naturally via the idempotent restocks + flip below — no marker needed, nothing to detect.
//   - Flip committed, audit tail not yet reached (after the CAS flip, before the action_audit
//     insert): the row is already non-open but carries THIS key on received_idempotency_key — the
//     flip's own key stamp is the proof. Resumes by re-entering refund/restock (both independently
//     idempotent: the refund delegate replays via its own nested idempotency key, restock keyed per
//     return-line row id) and writing the missing audit tail.
//
// CANCEL GUARD (belt-and-braces): cancelOrderReturn below refuses (409 return_has_restocks) to
// cancel a return that already has a committed restock in the ledger — the crash window above can
// leave a return 'open' with one or more of its lines already restocked, and cancelling that return
// would let a merchant re-open the same units for a SECOND restock later without ever refunding
// this one. See cancelOrderReturn's own comment for the exact check.
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

  // Belt-and-braces restock guard (module header, "CANCEL GUARD"): a crash between the (now
  // refund-first) nested refund and the CAS flip in executeReturnReceivedAction can leave a return
  // still 'open' with one or more of its lines already restocked to the ledger. Cancelling such a
  // return would free it up to be re-received later — restocking those same units a SECOND time
  // while the original refund from the crashed attempt is never issued. restockReturnLines' own
  // idempotency key is deterministic (`restockreturn:<return-line row id>`), so this is a single
  // exact .in() lookup against the ledger, not a LIKE scan. A return with no lines yet (shouldn't
  // happen — createOrderReturn always inserts at least one) skips the query outright.
  const returnLines = await loadReturnLines(sb, shopId, returnId);
  if (returnLines.length > 0) {
    const restockKeys = returnLines.map((l) => `restockreturn:${l.id}`);
    const ledgerRes = await sb
      .from("inventory_ledger")
      .select("id")
      .eq("shop_id", shopId)
      .in("idempotency_key", restockKeys);
    if (ledgerRes.error) throw ledgerRes.error;
    if ((ledgerRes.data ?? []).length > 0) {
      throw new CalderynError({
        code: "return_has_restocks",
        status: 409,
        message: `Return ${returnId} already has a committed restock and cannot be cancelled.`,
      });
    }
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

/** Order-ownership check for the receive/cancel routes (a returnId alone carries no order scoping
 *  of its own — every write route accepts BOTH the URL's :id and a body-supplied return_id, and
 *  must refuse a mismatch rather than silently letting one order's URL act on some OTHER order's
 *  return). Shop-scoped; false for a missing return OR one that belongs to a different order. */
export async function returnBelongsToOrder(
  shopId: string,
  returnId: string,
  orderId: string,
  sb: SupabaseClient = getSupabase(),
): Promise<boolean> {
  const { data, error } = await sb
    .from("order_return")
    .select("id")
    .eq("shop_id", shopId)
    .eq("id", returnId)
    .eq("order_id", orderId)
    .maybeSingle();
  if (error) throw error;
  return !!data;
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
 * Verifies a matched `<idempotencyKey>:refund` execution is actually a succeeded `issue_refund`
 * audit row FOR THIS ORDER (mirrors cancel.server.ts's priorRefundBelongsToThisOrder — idempotency
 * keys are caller-supplied strings, so a literal sub-key match alone is not proof; the audit row's
 * action_kind + outcome + params.order_id must all check out, shop-scoped by id). Returns the
 * refunded amount (refund.server.ts persists it as params.amount_cents) so the resume path can
 * report it without re-deriving anything from the ledger the crashed attempt already moved.
 */
async function verifyPriorRefundForReturn(
  sb: SupabaseClient,
  shopId: string,
  auditId: string,
  orderId: string,
): Promise<number | null> {
  const { data, error } = await sb
    .from("action_audit")
    .select("action_kind, outcome, params")
    .eq("shop_id", shopId)
    .eq("id", auditId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as Record<string, unknown>;
  if (row.action_kind !== "issue_refund" || row.outcome !== "succeeded") return null;
  const params = (row.params ?? {}) as Record<string, unknown>;
  if (params.order_id !== orderId) return null;
  return Number(params.amount_cents ?? 0);
}

/**
 * Mark a return received: restock requested lines (best-effort, tracked-only), refund the return's
 * total (delegated to actions/refund.server.ts, skipped entirely when the total is 0), flip the
 * return open -> closed (CAS, tolerant of a concurrent retry already having flipped it), and audit.
 *
 * Binding flow (see module header for the crash-window rationale): replay via priorExecutionForKey
 * -> load return + lines (+ order, for the over-refund fallback) -> resume-or-validate -> refund
 * the line total when > 0 -> per-line restock -> CAS status flip -> one action_audit row. Refund
 * runs BEFORE restock (see module header, Fix 2): a refund failure must never strand a committed
 * restock behind a return that's still open and cancellable.
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
  //    tail never landed. Resume straight into refund/restock (both independently idempotent) and
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

  // 3b. Refund-before-flip crash-resume check (module header): a DIFFERENT crash window than
  //     isResume above — the nested refund below committed and moved money, but the process died
  //     before the CAS flip landed, so the row is STILL 'open' with received_idempotency_key still
  //     null. Only reachable (and only checked) when this return actually calls the refund
  //     executor — a zero-refund return never does, so it has nothing to resume around here.
  let resumeAfterRefundCommit = false;
  let resumedRefundedCents = 0;
  if (!isResume && ret.status === "open" && totalRefundCents > 0) {
    const priorRefund = await priorExecutionForKey(shopId, `${input.idempotencyKey}:refund`, sb);
    if (priorRefund) {
      const verifiedAmount = await verifyPriorRefundForReturn(sb, shopId, priorRefund.id, ret.orderId);
      if (verifiedAmount !== null) {
        resumeAfterRefundCommit = true;
        resumedRefundedCents = verifiedAmount;
      }
    }
  }

  if (!isResume && !resumeAfterRefundCommit) {
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

    // 3c. Over-refund pre-check BEFORE any write (fix I1's pattern, edit.server.ts): the refund
    //     this return would issue must not exceed what remains refundable on the order. Skipped
    //     entirely on a resume (either kind, guarded above) — the ledger already reflects this
    //     return's own committed refund, so re-deriving it here would false-reject.
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

  // 4. Refund the return's total via the shared executor, nested idempotency key, BEFORE any
  //    restock (Fix 2, module header): a refund failure here must never leave a committed restock
  //    behind a return that's still open and cancellable. Skipped when the total is 0 (e.g. every
  //    line refunds $0 — a restocking-fee-only return, mirrors edit.server.ts's zero-price-line
  //    skip) OR when resumeAfterRefundCommit already proved this exact refund committed pre-crash —
  //    the verified amount from that prior execution is reused directly instead of calling the
  //    refund executor again.
  let refundedCents = 0;
  if (resumeAfterRefundCommit) {
    refundedCents = resumedRefundedCents;
  } else if (totalRefundCents > 0) {
    const refundResult = await executeRefundAction(
      shopId,
      {
        orderId: ret.orderId,
        amountCents: totalRefundCents,
        idempotencyKey: `${input.idempotencyKey}:refund`,
        actor: input.actor,
        reason: "return received",
        restock: false, // restock is handled per-line below, not by the refund executor's whole-order path
      },
      sb,
    );
    refundedCents = refundResult.amountCents;
  }

  // 5. Per-line restock (tracked only, best-effort — see restockReturnLines's own header), AFTER
  //    the refund above has committed (Fix 2): a restock failure at this point is the already-
  //    tolerated surfaced path — logged and reported in the result/audit params below, never thrown
  //    past the audit tail, mirroring edit.server.ts's own restock-after-refund stance. Always
  //    re-run, resume or not — each restock is idempotent (keyed per return-line row id), so
  //    re-issuing it on a resume is a safe no-op, not a double restock.
  const { restockedLines, restockErrors } = await restockReturnLines(sb, shopId, ret.orderId, lines);

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
        ...(resumeAfterRefundCommit ? { resumed_after_refund_crash: true } : {}),
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
