// app/lib/actions/refund.server.ts
// Issue a Stripe refund against a Calderyn-OWNED order as a first-class audited action
// (platform pivot #3b). This is the merchant/MCP/autopilot-brain counterpart to the read-only
// refund_fact MIRROR the Shopify refunds/create webhook produces — it MOVES money (Stripe Refund),
// writes a NEGATIVE transaction_ledger row, transitions the owned order, and emits refund_fact
// NATIVELY with a gid://calderyn/ external id that can never collide with the mirrored
// gid://shopify/RefundLineItem rows.
//
// Only orders PAID THROUGH the owned checkout can be refunded here: the guard is the presence of a
// shop-scoped payment_intent (+ a capture ledger row) for the order. A mirrored Shopify order has
// no payment_intent, so it is refused with a clear message (refund it in Shopify/Stripe directly).
//
// UNDO: a Stripe refund is IRREVERSIBLE — there is no "un-refund" call — so this action is
// audited-but-NOT-undoable. undo.server.ts refuses an issue_refund undo loudly and v_audit_view
// withholds the undo affordance (see 20260703030300_v_audit_view_refund_no_undo.sql).
//
// ATOMICITY / FAILURE MODE (rule 12). Order of operations: validate + guard -> Stripe refund ->
// record_refund_ledger (atomic over-refund guard + negative ledger row) -> native refund_fact ->
// order transition -> action_audit. The single money-critical atomic step is record_refund_ledger
// (SELECT ... FOR UPDATE serializes concurrent refunds; unique(stripe_event_id,kind) dedups a
// replay). Stripe is ALSO an authoritative money guard — it rejects a refund exceeding the
// refundable amount — so the money can never be double-spent even under a race. If Stripe succeeds
// but a later DB step fails, we LOG LOUDLY with the Stripe refund id and throw: the refund is
// visible in Stripe + (once the ledger row lands) the ledger, and every write is idempotent, so
// the state is reconcilable, never a silent double-refund or drift. The ledger-written-but-audit-
// insert-failed window is the SAME accepted, loudly-logged reconcile ceiling undo.server.ts
// documents for its reversal-applied-but-undo-row-failed window (convention, not a new risk model).

import type { SupabaseClient } from "@supabase/supabase-js";
import { CalderynError } from "../calderyn.server";
import { transitionOrder } from "../order/order.server";
import { isOrderState, type OrderState } from "../order/state";
import { createStripeRefund, type StripeRefundInput, type StripeRefundResult } from "../payments/refund.server";
import { priorExecutionForKey, insertAuditWithIdempotency } from "./execute.server";

/** Owned-order states a refund may act on. checkout_pending/cancelled/cart are not refundable. */
const REFUNDABLE_STATES: ReadonlySet<OrderState> = new Set<OrderState>([
  "paid",
  "fulfilled",
  "partially_refunded",
]);

export interface RefundActionInput {
  /** orders.id (the owned OLTP order). Also the payment_intent.order_ref linkage. */
  orderId: string;
  /** Positive refund magnitude in cents. Omit to refund the FULL remaining (captured − refunded). */
  amountCents?: number;
  /** Stable key: dedups the action AND is handed to Stripe so a retry can't double-refund. */
  idempotencyKey: string;
  actor?: string;
  triggerReason?: string | null;
  /** Merchant free-text note (persisted to audit params only — NOT sent to Stripe). */
  reason?: string | null;
}

export interface RefundActionResult {
  auditId: string;
  outcome: "succeeded";
  refundId: string | null;
  amountCents: number;
  capturedCents: number;
  refundedTotalCents: number;
  /** The order's resulting state (refunded when fully refunded, else partially_refunded). */
  orderState: OrderState;
  replayed: boolean;
}

export interface RefundDeps {
  /** Injectable Stripe seam so the executor is unit-testable without a live Stripe client. */
  createRefund?: (input: StripeRefundInput) => Promise<StripeRefundResult>;
}

interface OrderRow {
  state: OrderState;
  currency: string;
}
interface PaymentIntentRow {
  id: string;
  stripe_pi_id: string;
  stripe_account_id: string | null;
  currency: string;
}
interface LedgerTotals {
  capturedCents: number;
  refundedCents: number;
}

/** Native Calderyn refund GIDs — distinct from gid://shopify/Refund* so a native emit and a
 *  webhook-mirrored row for the same underlying event never collide on (shop_id, external_line_id). */
function refundGid(refundId: string): string {
  return `gid://calderyn/Refund/${refundId}`;
}
function refundLineGid(refundId: string): string {
  // One refund_fact line per amount-based refund; the stable Stripe refund id keeps the upsert
  // idempotent across retries (a random uuid would duplicate on replay). Namespaced under
  // RefundLine/ per the #3b convention.
  return `gid://calderyn/RefundLine/${refundId}`;
}

async function loadOrder(sb: SupabaseClient, shopId: string, orderId: string): Promise<OrderRow> {
  const { data, error } = await sb
    .from("orders")
    .select("state, currency")
    .eq("shop_id", shopId)
    .eq("id", orderId)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    throw new CalderynError({ code: "order_not_found", status: 404, message: `Order ${orderId} not found.` });
  }
  const state = String((data as Record<string, unknown>).state);
  if (!isOrderState(state) || !REFUNDABLE_STATES.has(state)) {
    throw new CalderynError({
      code: "order_not_refundable",
      status: 409,
      message: `Order ${orderId} is '${state}'; only a paid, fulfilled, or partially-refunded order can be refunded.`,
    });
  }
  return { state, currency: String((data as Record<string, unknown>).currency ?? "usd") };
}

async function loadPaymentIntent(
  sb: SupabaseClient,
  shopId: string,
  orderId: string,
): Promise<PaymentIntentRow> {
  const { data, error } = await sb
    .from("payment_intent")
    .select("id, stripe_pi_id, stripe_account_id, currency")
    .eq("shop_id", shopId)
    .eq("order_ref", orderId)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    // No owned PaymentIntent ⇒ this order was NOT paid through the Calderyn checkout (e.g. a
    // Shopify order mirrored via webhooks). Refuse — Calderyn cannot refund a charge it never made.
    throw new CalderynError({
      code: "order_not_owned_payment",
      status: 422,
      message: `Order ${orderId} was not paid through Calderyn checkout, so it can't be refunded here — refund it in Stripe/Shopify directly.`,
    });
  }
  const row = data as Record<string, unknown>;
  return {
    id: String(row.id),
    stripe_pi_id: String(row.stripe_pi_id),
    stripe_account_id: row.stripe_account_id == null ? null : String(row.stripe_account_id),
    currency: String(row.currency ?? "usd"),
  };
}

async function loadLedgerTotals(
  sb: SupabaseClient,
  shopId: string,
  paymentIntentId: string,
): Promise<LedgerTotals> {
  const { data, error } = await sb
    .from("transaction_ledger")
    .select("kind, amount_cents")
    .eq("shop_id", shopId)
    .eq("payment_intent_id", paymentIntentId);
  if (error) throw error;
  let capturedCents = 0;
  let refundedCents = 0;
  for (const r of (data ?? []) as Record<string, unknown>[]) {
    const cents = Number(r.amount_cents ?? 0);
    if (r.kind === "capture") capturedCents += cents;
    else if (r.kind === "refund") refundedCents += -cents; // refund rows are negative
  }
  return { capturedCents, refundedCents };
}

/** Reconstruct a result from a prior audit row on an idempotent replay. */
async function resultFromAudit(
  sb: SupabaseClient,
  shopId: string,
  auditId: string,
): Promise<RefundActionResult> {
  const { data, error } = await sb
    .from("action_audit")
    .select("id, params, post_state")
    .eq("shop_id", shopId)
    .eq("id", auditId)
    .maybeSingle();
  if (error) throw error;
  const params = ((data?.params ?? {}) as Record<string, unknown>) ?? {};
  const post = ((data?.post_state ?? {}) as Record<string, unknown>) ?? {};
  const state = String(post.state ?? "refunded");
  return {
    auditId,
    outcome: "succeeded",
    refundId: params.stripe_refund_id ? String(params.stripe_refund_id) : null,
    amountCents: Number(params.amount_cents ?? 0),
    capturedCents: Number(params.captured_cents ?? 0),
    refundedTotalCents: Number(params.refunded_total_cents ?? post.refunded_cents ?? 0),
    orderState: (isOrderState(state) ? state : "refunded") as OrderState,
    replayed: true,
  };
}

export async function executeRefundAction(
  shopId: string,
  input: RefundActionInput,
  sb: SupabaseClient,
  deps: RefundDeps = {},
): Promise<RefundActionResult> {
  if (!shopId) throw new Error("shopId is required");
  if (!input.orderId) {
    throw new CalderynError({ code: "invalid_refund", status: 422, message: "orderId is required." });
  }
  if (!input.idempotencyKey) {
    throw new CalderynError({ code: "invalid_refund", status: 422, message: "idempotencyKey is required." });
  }
  if (
    input.amountCents !== undefined &&
    (!Number.isInteger(input.amountCents) || input.amountCents <= 0)
  ) {
    throw new CalderynError({
      code: "invalid_refund",
      status: 422,
      message: "Refund amount must be a positive whole number of cents.",
    });
  }

  // 1. Idempotency: a completed refund with this key returns the SAME result (no second charge-back).
  const prior = await priorExecutionForKey(shopId, input.idempotencyKey, sb);
  if (prior) return resultFromAudit(sb, shopId, prior.id);

  // 2. Ownership + refundable-state guard.
  const order = await loadOrder(sb, shopId, input.orderId);
  // 3. Owned-checkout guard: only an order Calderyn charged (has a payment_intent) is refundable here.
  const pi = await loadPaymentIntent(sb, shopId, input.orderId);
  // 4. Money truth from the ledger (captured / already-refunded / remaining).
  const totals = await loadLedgerTotals(sb, shopId, pi.id);
  if (totals.capturedCents <= 0) {
    throw new CalderynError({
      code: "order_not_captured",
      status: 422,
      message: `Order ${input.orderId} has no captured payment to refund.`,
    });
  }
  const remaining = totals.capturedCents - totals.refundedCents;
  const amountCents = input.amountCents ?? remaining;
  if (amountCents <= 0) {
    throw new CalderynError({
      code: "already_refunded",
      status: 409,
      message: `Order ${input.orderId} is already fully refunded.`,
    });
  }
  // Fast-fail over-refund pre-check (record_refund_ledger re-checks this atomically, and Stripe
  // itself rejects an over-refund — this is the friendly UX-layer guard).
  if (amountCents > remaining) {
    throw new CalderynError({
      code: "over_refund",
      status: 422,
      message: `Refund of ${amountCents}¢ exceeds the ${remaining}¢ remaining on order ${input.orderId}.`,
    });
  }
  // Pre-flight projection used only as the fallback when the ledger RPC's return is unreadable;
  // the AUTHORITATIVE resulting state comes from record_refund_ledger.fully_refunded below.
  const refundedAfter = totals.refundedCents + amountCents;

  // 5. Stripe refund. A failure throws (surfaced, rule 12); no audit/ledger row is written for a
  // refund that never moved money — mirrors adjust-price's "audit only on success" stance.
  const createRefund = deps.createRefund ?? createStripeRefund;
  let refund: StripeRefundResult;
  try {
    refund = await createRefund({
      paymentIntentId: pi.stripe_pi_id,
      amountCents,
      stripeAccountId: pi.stripe_account_id,
      idempotencyKey: input.idempotencyKey,
    });
  } catch (err) {
    throw new CalderynError({
      code: "stripe_refund_failed",
      status: 502,
      message: err instanceof Error ? err.message : "Stripe refund failed.",
    });
  }

  // 6. Atomic over-refund guard + NEGATIVE ledger row. From here the money has moved on Stripe, so
  // any failure is logged LOUDLY with the refund id and surfaced — never swallowed (rule 12).
  const currency = pi.currency || order.currency || "usd";
  const { data: ledgerData, error: ledgerErr } = await sb.rpc("record_refund_ledger", {
    p_shop_id: shopId,
    p_payment_intent_id: pi.id,
    p_order_ref: input.orderId,
    p_amount_cents: amountCents,
    p_currency: currency,
    p_stripe_ref: refund.chargeId ?? refund.refundId,
    p_stripe_event_id: refund.refundId,
    p_occurred_at: new Date().toISOString(),
  });
  if (ledgerErr) {
    console.error(
      `[refund] STRIPE REFUND ${refund.refundId} SUCCEEDED for order ${input.orderId} (shop ${shopId}) but the ledger write failed — reconcile via the Stripe refund id`,
      ledgerErr,
    );
    throw new CalderynError({
      code: "refund_ledger_failed",
      status: 500,
      message: `Stripe refund ${refund.refundId} was issued but recording it failed — do not retry blindly; reconcile via the audit log / Stripe.`,
    });
  }
  const ledger = (ledgerData ?? {}) as { captured_cents?: number; refunded_cents?: number; fully_refunded?: boolean };
  const capturedCents = Number(ledger.captured_cents ?? totals.capturedCents);
  const refundedTotalCents = Number(ledger.refunded_cents ?? refundedAfter);
  const fullyRefunded = Boolean(ledger.fully_refunded ?? refundedTotalCents >= capturedCents);
  const resolvedState: OrderState = fullyRefunded ? "refunded" : "partially_refunded";

  // 7. Native refund_fact emit (analytics mirror). Best-effort: the money + ledger already
  // committed, so a fact-write failure is logged + recorded on the audit row, never fails the
  // refund. order_id links to the warehouse order_fact emitted for this owned order (#2b).
  const params: Record<string, unknown> = {
    target: input.orderId,
    order_id: input.orderId,
    amount_cents: amountCents,
    currency,
    stripe_refund_id: refund.refundId,
    stripe_charge_id: refund.chargeId,
    stripe_account_id: pi.stripe_account_id,
    captured_cents: capturedCents,
    refunded_total_cents: refundedTotalCents,
    fully_refunded: fullyRefunded,
    resulting_state: resolvedState,
    reason: input.reason ?? null,
    external_line_id: refundLineGid(refund.refundId),
  };
  try {
    await emitNativeRefundFact(sb, shopId, input.orderId, refund.refundId, amountCents);
  } catch (err) {
    params.refund_fact_error = err instanceof Error ? err.message : String(err);
    console.error(
      `[refund] native refund_fact emit failed for refund ${refund.refundId} (order ${input.orderId}); ledger is authoritative`,
      err,
    );
  }

  // 8. Transition the owned order — ONLY when the state actually changes. A second partial refund on
  // an already-partially_refunded order keeps the same state (identity move is illegal), so we skip
  // it. Best-effort with a loud log: the ledger is the money truth; a stale state label reconciles.
  if (resolvedState !== order.state) {
    try {
      await transitionOrder(shopId, input.orderId, resolvedState, `refund:${refund.refundId}`);
    } catch (err) {
      params.transition_error = err instanceof Error ? err.message : String(err);
      console.error(
        `[refund] order ${input.orderId} refund ${refund.refundId} recorded in the ledger but the ${order.state}->${resolvedState} transition failed — reconcile the order state`,
        err,
      );
    }
  }

  // 9. One append-only action_audit row (+ idempotency marker). issue_refund recovers $0 impact
  // (a refund is money OUT, not clawed-back waste) — recoveredCentsFromStates returns 0 for it.
  // Loud-log before rethrow: after a FULL refund the order is already 'refunded', so a retry is
  // refused as non-refundable and this audit row would otherwise be lost silently — the refund id
  // in the log is the reconcile handle (ledger stays the money truth).
  let audit;
  try {
    audit = await insertAuditWithIdempotency(
      shopId,
      input.idempotencyKey,
      {
        alert_id: null,
        action_kind: "issue_refund",
        params,
        outcome: "succeeded",
        pre_state: { state: order.state, refunded_cents: totals.refundedCents },
        post_state: { state: resolvedState, refunded_cents: refundedTotalCents },
        last_error: null,
        actor_user_id: input.actor ?? "merchant",
        trigger_reason: input.triggerReason ?? null,
      },
      sb,
    );
  } catch (err) {
    console.error(
      `[refund] order ${input.orderId} refund ${refund.refundId} recorded in the ledger but the action_audit insert failed — reconcile from the ledger`,
      err,
    );
    throw err;
  }

  return {
    auditId: audit.id,
    outcome: "succeeded",
    refundId: refund.refundId,
    amountCents,
    capturedCents,
    refundedTotalCents,
    orderState: resolvedState,
    replayed: false,
  };
}

/**
 * Emit ONE native refund_fact row for an amount-based refund. Coexists with webhook-mirrored rows:
 * the gid://calderyn/RefundLine/ external_line_id can never collide with gid://shopify/RefundLineItem.
 * order_id resolves to the warehouse order_fact emitted for this owned order (#2b) so return-rate
 * analytics attribute the refund to the order; if that emit hasn't landed, order_id stays null
 * (tolerated, never dropped — same stance emitPaidOrder takes for unresolved links). sku_id is null
 * for an amount-based refund (no per-line allocation), which v_sku_returns_30d already excludes.
 */
async function emitNativeRefundFact(
  sb: SupabaseClient,
  shopId: string,
  orderId: string,
  refundId: string,
  amountCents: number,
): Promise<void> {
  let orderFactId: string | null = null;
  const { data: fact, error: factErr } = await sb
    .from("order_fact")
    .select("id")
    .eq("shop_id", shopId)
    .eq("external_id", `gid://calderyn/Order/${orderId}`)
    .maybeSingle();
  if (factErr) throw factErr;
  orderFactId = (fact as { id?: string } | null)?.id ?? null;

  const nowIso = new Date().toISOString();
  const { error } = await sb.from("refund_fact").upsert(
    {
      shop_id: shopId,
      order_id: orderFactId,
      sku_id: null,
      external_id: refundGid(refundId),
      external_line_id: refundLineGid(refundId),
      quantity: 0,
      subtotal_cents: amountCents,
      processed_at: nowIso,
      source_version: Date.parse(nowIso),
    },
    { onConflict: "shop_id,external_line_id" },
  );
  if (error) throw error;
}
