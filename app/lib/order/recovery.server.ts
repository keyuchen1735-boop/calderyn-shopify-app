// app/lib/order/recovery.server.ts
//
// Abandoned-checkout recovery (orders phase 3, Task 4): a resume-link email sent to a buyer
// whose storefront checkout stalled, giving them a window to come back and pay before
// abandon-reaper.server.ts voids the PaymentIntent and cancels the order at 24h. A recoverable
// order is channel='storefront' and either still checkout_pending, or already cancelled BY THE
// REAPER specifically (reason REAPER_CANCEL_REASON below, kept in lockstep with the exact string
// abandon-reaper.server.ts hands to transitionOrder) — a merchant-initiated cancellation is never
// recoverable, and the reason string on order_state_transition is the only thing distinguishing
// the two once an order has moved to `cancelled`.
//
// Marketing consent is a hard gate for BOTH the automatic sweep and the merchant's manual resend
// button (dashboard.api.orders.$id.recovery-email.tsx): a merchant can never override a buyer's
// declined consent by clicking resend.

import { getSupabase } from "~/lib/supabase.server";
import { sendRecoveryEmailMessage } from "./notify-email.server";

/** The exact reason string abandon-reaper.server.ts stamps on the order_state_transition row
 *  when it cancels a stalled checkout (`transitionOrder(shopId, orderId, "cancelled",
 *  "cron:abandoned_checkout")`). Kept here as a named constant, not re-derived, so a future rename
 *  of the reaper's reason string breaks this file's compile/tests loudly instead of silently
 *  un-recovering every reaper-cancelled order. */
export const REAPER_CANCEL_REASON = "cron:abandoned_checkout";

export interface SendRecoveryEmailResult {
  sent: boolean;
  reason?: string;
}

export interface AutoSendRecoveryResult {
  sent: number;
  skipped: number;
}

/** True iff the order's most recent transition TO `cancelled` carries the reaper's exact reason
 *  string. A merchant cancel (executeCancelAction et al.) writes a different reason, so this is
 *  false for those — never recoverable. */
async function wasReaperCancelled(shopId: string, orderId: string): Promise<boolean> {
  const { data, error } = await getSupabase()
    .from("order_state_transition")
    .select("reason")
    .eq("shop_id", shopId)
    .eq("order_id", orderId)
    .eq("to_state", "cancelled")
    .order("occurred_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  const row = (data ?? [])[0] as Record<string, unknown> | undefined;
  return row?.reason === REAPER_CANCEL_REASON;
}

/**
 * True iff this order state is one a recovery email (or the resume link) can still act on: still
 * stalled at checkout, or cancelled specifically by the reaper. Exported so the resume route
 * (storefront.recover.$token.tsx) applies the exact same recoverability rule sendRecoveryEmail
 * does, rather than re-deriving it.
 */
export async function isRecoverableOrderState(
  shopId: string,
  orderId: string,
  state: string,
): Promise<boolean> {
  if (state === "checkout_pending") return true;
  if (state === "cancelled") return wasReaperCancelled(shopId, orderId);
  return false;
}

interface RecoveryOrderRow {
  id: string;
  buyerId: string;
  channel: string;
  state: string;
  confirmationToken: string;
  totalCents: number;
  currency: string;
  recoveryEmailSentAt: string | null;
}

async function loadRecoveryOrder(shopId: string, orderId: string): Promise<RecoveryOrderRow | null> {
  const { data, error } = await getSupabase()
    .from("orders")
    .select("id, buyer_id, channel, state, confirmation_token, total_cents, currency, recovery_email_sent_at")
    .eq("shop_id", shopId)
    .eq("id", orderId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as Record<string, unknown>;
  return {
    id: String(row.id),
    buyerId: String(row.buyer_id),
    channel: String(row.channel),
    state: String(row.state),
    confirmationToken: String(row.confirmation_token),
    totalCents: Number(row.total_cents ?? 0),
    currency: String(row.currency ?? "usd"),
    recoveryEmailSentAt: row.recovery_email_sent_at == null ? null : String(row.recovery_email_sent_at),
  };
}

async function buyerEmail(shopId: string, buyerId: string): Promise<string | null> {
  const { data, error } = await getSupabase()
    .from("buyer_dim")
    .select("email_normalized")
    .eq("shop_id", shopId)
    .eq("id", buyerId)
    .maybeSingle();
  if (error) throw error;
  const email = data ? String((data as Record<string, unknown>).email_normalized ?? "") : "";
  return email || null;
}

/** True iff the buyer's most recent marketing-policy consent decision is accepted=true. A buyer
 *  with no consent row at all (never asked, or an order that predates consent capture) is treated
 *  as NOT consented — recovery email is opt-in, never a default. */
async function hasMarketingConsent(shopId: string, buyerId: string): Promise<boolean> {
  const { data, error } = await getSupabase()
    .from("buyer_consent")
    .select("accepted, captured_at")
    .eq("shop_id", shopId)
    .eq("buyer_id", buyerId)
    .eq("policy", "marketing")
    .order("captured_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  const row = (data ?? [])[0] as Record<string, unknown> | undefined;
  return row?.accepted === true;
}

async function orderLines(shopId: string, orderId: string): Promise<Array<{ title: string; quantity: number }>> {
  const { data, error } = await getSupabase()
    .from("order_line")
    .select("title_snapshot, quantity")
    .eq("shop_id", shopId)
    .eq("order_id", orderId);
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map((l) => ({
    title: String(l.title_snapshot),
    quantity: Number(l.quantity ?? 0),
  }));
}

/**
 * Send (or re-send) the resume-link recovery email for one order. Guards, in order:
 *   1. the order must exist for this shop,
 *   2. channel must be 'storefront' (an invoice or test-probe order is never recoverable here),
 *   3. state must be checkout_pending or reaper-cancelled (isRecoverableOrderState),
 *   4. the AUTOMATIC path additionally requires recovery_email_sent_at is null (at-most-once);
 *      the MANUAL (merchant) path may re-send even when already stamped,
 *   5. the buyer must have an email on file,
 *   6. marketing consent must be accepted — this gate applies to BOTH paths; a merchant can
 *      never override a buyer's declined consent by clicking resend.
 * On a successful delivery, stamps recovery_email_sent_at = now() (shop-scoped) so the automatic
 * sweep never re-sends. A transport failure is NOT stamped — the email genuinely never reached
 * the buyer, so at-most-once must not "spend" its one shot on a bounce.
 */
export async function sendRecoveryEmail(
  shopId: string,
  orderId: string,
  opts: { manual?: boolean } = {},
): Promise<SendRecoveryEmailResult> {
  if (!shopId) throw new Error("shopId is required");
  if (!orderId) throw new Error("orderId is required");

  const order = await loadRecoveryOrder(shopId, orderId);
  if (!order) return { sent: false, reason: "not_found" };
  if (order.channel !== "storefront") return { sent: false, reason: "not_recoverable" };
  if (!(await isRecoverableOrderState(shopId, orderId, order.state))) {
    return { sent: false, reason: "not_recoverable" };
  }
  if (!opts.manual && order.recoveryEmailSentAt) {
    return { sent: false, reason: "already_sent" };
  }

  const email = await buyerEmail(shopId, order.buyerId);
  if (!email) return { sent: false, reason: "no_buyer_email" };

  if (!(await hasMarketingConsent(shopId, order.buyerId))) {
    return { sent: false, reason: "no_consent" };
  }

  const lines = await orderLines(shopId, orderId);
  const delivery = await sendRecoveryEmailMessage(shopId, orderId, {
    confirmationToken: order.confirmationToken,
    lines,
    totalCents: order.totalCents,
  });
  if (!delivery.sent) {
    return { sent: false, reason: delivery.error ?? "delivery_failed" };
  }

  const stamp = await getSupabase()
    .from("orders")
    .update({ recovery_email_sent_at: new Date().toISOString() })
    .eq("shop_id", shopId)
    .eq("id", orderId);
  if (stamp.error) throw stamp.error;

  return { sent: true };
}

// Checkouts old enough that the buyer likely isn't coming right back, but young enough that the
// reaper hasn't yet cancelled them: the recovery window this sweep targets. Distinct from
// list.server.ts's ABANDON_AFTER_MS (a merchant-facing 1h "show it on the Abandoned tab"
// threshold) and abandon-reaper.server.ts's REAP_AFTER_MS (the 24h cancel cutoff this upper bound
// mirrors, kept as its own constant rather than imported so the two modules stay decoupled).
const RECOVERY_MIN_AGE_MS = 4 * 60 * 60 * 1000;
const RECOVERY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const AUTO_SEND_BATCH_LIMIT = 50;

/**
 * Sweep every shop (this is a platform cron, not shop-scoped — mirrors reapAbandonedCheckouts)
 * for storefront checkouts stalled between 4h and 24h old with no recovery email sent yet, and
 * send one to each, bounded to AUTO_SEND_BATCH_LIMIT per run. Each order is independently gated by
 * sendRecoveryEmail's full guard chain (consent, at-most-once, etc.) and isolated in its own
 * try/catch so one failure never aborts the sweep for the rest of the batch (rule 12).
 */
export async function autoSendRecoveryEmails(): Promise<AutoSendRecoveryResult> {
  const now = Date.now();
  const cutoffOld = new Date(now - RECOVERY_MAX_AGE_MS).toISOString();
  const cutoffRecent = new Date(now - RECOVERY_MIN_AGE_MS).toISOString();

  const candidatesRes = await getSupabase()
    .from("orders")
    .select("id, shop_id")
    .eq("state", "checkout_pending")
    .eq("channel", "storefront")
    .is("recovery_email_sent_at", null)
    .gt("created_at", cutoffOld)
    .lt("created_at", cutoffRecent)
    .order("created_at", { ascending: true })
    .limit(AUTO_SEND_BATCH_LIMIT);
  if (candidatesRes.error) throw candidatesRes.error;
  const candidates = (candidatesRes.data ?? []) as Array<{ id: string; shop_id: string }>;

  let sent = 0;
  let skipped = 0;
  for (const row of candidates) {
    const orderId = String(row.id);
    const shopId = String(row.shop_id);
    try {
      const result = await sendRecoveryEmail(shopId, orderId);
      if (result.sent) sent++;
      else skipped++;
    } catch (err) {
      skipped++;
      console.error(`[recovery] auto-send failed for order ${orderId} (shop ${shopId}); continuing:`, err);
    }
  }
  return { sent, skipped };
}
