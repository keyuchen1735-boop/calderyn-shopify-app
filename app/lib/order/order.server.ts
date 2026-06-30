// Order state transitions + inventory-reservation stub (platform pivot #2a). Server-only:
// reaches Postgres through the service-role client (getSupabase, BYPASSRLS), threading
// shop_id explicitly on every read/write — same access pattern as buyer/identity.server.ts
// and payments/stripe.server.ts. The migration's current_shop_id() RLS policies guard the
// PostgREST path; this is the application (service-role) path.

import { getSupabase } from "~/lib/supabase.server";
import { assertLegalTransition, type OrderState } from "./state";

export interface OrderTransition {
  id: string;
  orderId: string;
  fromState: OrderState;
  toState: OrderState;
  reason: string | null;
  occurredAt: string;
}

export interface ReservationResult {
  reserved: boolean;
  reason: string;
}

export interface ReservationLine {
  variantId: string;
  quantity: number;
}

/**
 * Move an order to `toState`, enforcing the legal-transition state machine (state.ts) and
 * writing exactly one append-only order_state_transition audit row. Fails visibly (rule 12):
 *   - throws if the order does not exist for this shop (never creates one),
 *   - throws on an illegal transition WITHOUT writing anything (never a silent no-op).
 *
 * ponytail: read-check-insert-update across three non-tx PostgREST calls (mirrors the
 * non-atomic multi-write in buyer/identity.server.ts). The audit row is inserted BEFORE the
 * state UPDATE so a successful state change can never lack its audit row; a crash between
 * the two surfaces as a thrown error, not silent corruption. Atomicity + a row lock for
 * concurrent transitions is the upgrade: fold into a security-definer RPC like
 * record_stripe_event (which guards the order with `where state = <from>`), out of #2a scope.
 */
export async function transitionOrder(
  shopId: string,
  orderId: string,
  toState: OrderState,
  reason?: string,
): Promise<OrderTransition> {
  if (!shopId) throw new Error("shopId is required");
  if (!orderId) throw new Error("orderId is required");

  const sb = getSupabase();
  const current = await sb
    .from("orders")
    .select("state")
    .eq("shop_id", shopId)
    .eq("id", orderId)
    .maybeSingle();
  if (current.error) throw current.error;
  if (!current.data) {
    throw new Error(`order ${orderId} not found for shop ${shopId}`);
  }

  const fromState = String((current.data as Record<string, unknown>).state);
  // Throws on an illegal/unknown transition before any write (rule 12).
  assertLegalTransition(fromState, toState);

  const inserted = await sb
    .from("order_state_transition")
    .insert({
      shop_id: shopId,
      order_id: orderId,
      from_state: fromState,
      to_state: toState,
      reason: reason ?? null,
    })
    .select("id, order_id, from_state, to_state, reason, occurred_at")
    .single();
  if (inserted.error) throw inserted.error;
  if (!inserted.data) throw new Error("order_state_transition insert returned no row");

  // Compare-and-set on the state we validated against: `.eq("state", fromState)` makes the
  // UPDATE apply ONLY if the row is still in `fromState`. Without it the move is enforced against
  // the STALE read, so an order concurrently advanced between the read and the update (e.g.
  // checkout_pending -> cancelled by an abandon job) would be illegally overwritten to `toState`,
  // bypassing the state machine. `.select("id")` returns the affected rows so we can assert
  // exactly one moved; a 0-row update means the order changed (or vanished) under us — never
  // report success on a no-op state change (rule 12).
  const updated = await sb
    .from("orders")
    .update({ state: toState })
    .eq("shop_id", shopId)
    .eq("id", orderId)
    .eq("state", fromState)
    .select("id");
  if (updated.error) throw updated.error;
  const affected = (updated.data as unknown[] | null)?.length ?? 0;
  if (affected !== 1) {
    throw new Error(
      `transitionOrder updated ${affected} rows for order ${orderId} (shop ${shopId}); expected exactly 1 — the order changed under us`,
    );
  }

  return mapTransition(inserted.data as Record<string, unknown>);
}

/**
 * Inventory reservation — DELIBERATE NO-OP STUB. Returns a VISIBLE not-reserved flag
 * ({ reserved: false, reason: "stub" }) and logs it, so the checkout path can record that
 * no oversell protection was enforced. We must NOT silently claim a reservation happened
 * (rule 12).
 *
 * ponytail: real row-locked atomic decrement against the inventory ledger is John's #4
 * inventory-ledger track. Until that lands, every reservation is a no-op and callers MUST
 * treat reserved=false as "oversell is possible".
 */
export async function reserveInventory(
  shopId: string,
  lines: ReservationLine[],
): Promise<ReservationResult> {
  if (!shopId) throw new Error("shopId is required");
  const result: ReservationResult = { reserved: false, reason: "stub" };
  console.warn(
    `[order] inventory reservation NOT enforced (stub) for shop ${shopId}, ${lines.length} line(s); oversell is possible until #4 inventory-ledger ships`,
  );
  return result;
}

function mapTransition(row: Record<string, unknown>): OrderTransition {
  return {
    id: String(row.id),
    orderId: String(row.order_id),
    fromState: String(row.from_state) as OrderState,
    toState: String(row.to_state) as OrderState,
    reason: row.reason == null ? null : String(row.reason),
    occurredAt: String(row.occurred_at),
  };
}
