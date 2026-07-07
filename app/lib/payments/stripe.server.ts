import type Stripe from "stripe";
import { getSupabase } from "~/lib/supabase.server";
import { transitionOrder } from "~/lib/order/order.server";
import { emitPaidOrder } from "~/lib/order/emit.server";
import { sendOrderConfirmation } from "~/lib/order/confirmation-email.server";
import { commitReservation } from "~/lib/inventory/engine.server";
// Singleton lives in stripe-client.server so connect.server can use it without
// importing this module (which imports connect.server — would be a cycle).
import { getStripe } from "./stripe-client.server";
import { createRoutedPaymentIntent, applyAccountUpdate } from "./connect.server";

export { getStripe };

const KNOWN_CURRENCIES = new Set(["usd", "eur", "gbp", "cad", "aud"]);

/**
 * True when `currency` is a Stripe currency this integration can charge. Exposed so the
 * checkout origination path can reject an unsupported currency BEFORE writing the order —
 * createPaymentIntent (the last step) rejects it too, but by then an orphan checkout_pending
 * order + lines have already been persisted with no PaymentIntent.
 */
export function isSupportedCurrency(currency: string): boolean {
  return KNOWN_CURRENCIES.has(currency.toLowerCase());
}

/**
 * Create a Stripe PaymentIntent and persist the shop-scoped payment_intent row.
 * shopId leads because the warehouse has no RLS to infer the tenant on the
 * service-role write path. Returns the client secret for the Payment Element.
 */
export async function createPaymentIntent(
  shopId: string,
  amountCents: number,
  currency: string,
  orderRef?: string,
): Promise<{ paymentIntentId: string; clientSecret: string; amountCents: number; currency: string }> {
  if (!shopId) throw new Error("shopId is required");
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new Error(`amountCents must be a positive integer, got ${amountCents}`);
  }
  const cur = currency.toLowerCase();
  if (!KNOWN_CURRENCIES.has(cur)) {
    throw new Error(`unsupported currency: ${currency}`);
  }

  // Routing decision + destination→platform fallback live in ONE seam
  // (createRoutedPaymentIntent) shared with the ACP charge path.
  const { pi, stripeAccountId, applicationFeeCents } = await createRoutedPaymentIntent(shopId, {
    amount: amountCents,
    currency: cur,
    automatic_payment_methods: { enabled: true },
    metadata: { shop_id: shopId, order_ref: orderRef ?? "" },
  });
  if (!pi.client_secret) {
    throw new Error(`Stripe PaymentIntent ${pi.id} returned no client_secret`);
  }

  const { error } = await getSupabase().from("payment_intent").insert({
    shop_id: shopId,
    stripe_pi_id: pi.id,
    order_ref: orderRef ?? null,
    amount_cents: amountCents,
    currency: cur,
    status: pi.status,
    stripe_account_id: stripeAccountId,
    application_fee_cents: applicationFeeCents,
  });
  if (error) throw error;

  return {
    paymentIntentId: pi.id,
    clientSecret: pi.client_secret,
    amountCents,
    currency: cur,
  };
}

/**
 * Verify + idempotently process a Stripe webhook event over the RAW request body.
 * Returns the HTTP status the route should send plus whether this was a first
 * delivery (processed) or a duplicate (no-op). Writes nothing on bad/missing signature.
 */
export async function processStripeEvent(
  rawBody: string,
  signature: string | null,
): Promise<{ status: number; processed: boolean; duplicate: boolean }> {
  // TODO(parity): surface payment_intent / transaction_ledger in the Calderyn dashboard
  // payments view when #3 graduates from spike (CLAUDE.md "Dashboard parity").
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET is not configured");
  if (!signature) {
    return { status: 400, processed: false, duplicate: false };
  }

  // Signature verification via the SDK over raw bytes — never hand-rolled.
  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(rawBody, signature, secret);
  } catch {
    return { status: 400, processed: false, duplicate: false };
  }

  // Hosted Stripe Checkout (createCommerceCheckoutSession) does not pre-create a payment_intent
  // row the way the Payment Element path (createPaymentIntent) does — the PaymentIntent is born
  // inside Stripe. On checkout.session.completed the session carries that PI id plus our
  // shop_id/order_ref metadata, so we RECONCILE the row here. We do NOT capture or transition
  // here: the paired payment_intent.succeeded event does the money work through the normal path
  // below, now that the row exists. Idempotent (onConflict) so a redelivered session.completed is
  // a no-op, and the single-capture invariant holds (only the PI event writes the ledger).
  // ponytail: if payment_intent.succeeded is delivered BEFORE this event, its RPC 500s ("PI not
  // found") and Stripe retries — the row lands here first on the retry, so it self-heals. Fold the
  // provisioning into the succeeded path too if that transient retry ever proves costly.
  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    const sShopId = session.metadata?.shop_id;
    const piId =
      typeof session.payment_intent === "string"
        ? session.payment_intent
        : session.payment_intent?.id;
    if (!sShopId || !piId) {
      // Not ours (no shop_id) or a non-PaymentIntent session (e.g. setup mode) — ACK so Stripe
      // stops retrying, and surface it (rule 12) rather than 500-looping on an event not ours.
      console.warn(
        `[stripe] checkout.session.completed ${event.id}: missing shop_id or payment_intent; skipped`,
      );
      return { status: 200, processed: false, duplicate: false };
    }
    const { error: upsertErr } = await getSupabase()
      .from("payment_intent")
      .upsert(
        {
          shop_id: sShopId,
          stripe_pi_id: piId,
          order_ref: session.metadata?.order_ref ?? null,
          amount_cents: session.amount_total ?? 0,
          currency: session.currency ?? "usd",
        },
        { onConflict: "stripe_pi_id" },
      );
    if (upsertErr) throw upsertErr;
    return { status: 200, processed: true, duplicate: false };
  }

  // Stripe Connect account status changes (async enablement). A connected account whose
  // charges/payouts flip to enabled AFTER the merchant returns from onboarding emits
  // account.updated; without handling it the stored row stays charges_enabled=false forever and
  // destinationParamsFor keeps routing every PaymentIntent to the platform account. Sync the stored
  // row from the event's account object. ACK regardless (rule 12: a foreign account is not ours).
  if (event.type === "account.updated") {
    const account = event.data.object as Stripe.Account;
    const applied = await applyAccountUpdate(account);
    if (!applied) {
      console.warn(`[stripe] account.updated ${event.id}: account ${account.id} not linked to any shop; skipped`);
    }
    return { status: 200, processed: applied, duplicate: false };
  }

  // Only money-moving / status events touch the DB; ack everything else so Stripe stops retrying.
  if (event.type !== "payment_intent.succeeded" && event.type !== "payment_intent.payment_failed") {
    return { status: 200, processed: false, duplicate: false };
  }

  const pi = event.data.object as Stripe.PaymentIntent;
  const shopId = pi.metadata?.shop_id;
  if (!shopId) {
    // No shop_id metadata ⇒ this PaymentIntent was not created by Calderyn (e.g. another
    // integration, or a Dashboard PI, on the same Stripe account). ACK so Stripe stops
    // retrying, and log for visibility (rule 12) — 500-looping on an event that is not ours
    // to process would be a permanent retry storm, not useful failure-surfacing.
    console.warn(`[stripe] ignoring event ${event.id}: PaymentIntent ${pi.id} has no shop_id metadata`);
    return { status: 200, processed: false, duplicate: false };
  }

  const succeeded = event.type === "payment_intent.succeeded";
  const stripeRef =
    typeof pi.latest_charge === "string" && pi.latest_charge ? pi.latest_charge : pi.id;

  const { data, error } = await getSupabase().rpc("record_stripe_event", {
    p_event_id: event.id,
    p_type: event.type,
    p_shop_id: shopId,
    p_signature_verified: true,
    p_payload: event as unknown as Record<string, unknown>,
    p_stripe_pi_id: pi.id,
    p_new_status: succeeded ? "succeeded" : "failed",
    p_kind: succeeded ? "capture" : null,
    p_amount_cents: succeeded ? pi.amount_received : null,
    p_currency: pi.currency,
    p_stripe_ref: stripeRef,
    p_occurred_at: new Date(event.created * 1000).toISOString(),
  });
  if (error) throw error;

  const processed = data === true; // true = first delivery, false = duplicate no-op
  if (succeeded) {
    const orderRef = pi.metadata?.order_ref;
    if (!orderRef) {
      // A Calderyn PI without an order_ref can't be tied back to an order — surface it (rule 12)
      // rather than silently dropping the paid signal.
      console.warn(`[stripe] PI ${pi.id} succeeded but carries no order_ref metadata; no order transitioned`);
    } else {
      // STATE TRANSITION — an order reaches `paid` ONLY here, after Stripe confirms capture. Only
      // checkout_pending -> paid is legal; the state machine REJECTS (throws) a force-pay of any
      // other state, so an already-paid/cancelled order is never silently re-paid.
      if (processed) {
        // First delivery: perform the SoT transition + at-most-once confirmation email.
        await transitionOrder(shopId, orderRef, "paid", "stripe:payment_intent.succeeded");

        // ORDER-CONFIRMATION EMAIL (#2c-2) — first delivery ONLY, so the buyer is emailed
        // at-most-once and only for an order that genuinely reached `paid`. sendOrderConfirmation
        // never throws (a delivery failure is logged + swallowed inside it), so a flaky mailer
        // can never break payment processing or trigger a Stripe retry storm.
        await sendOrderConfirmation(shopId, orderRef);
      } else {
        // REDELIVERY SELF-HEAL (rule 12): a first-delivery TRANSIENT failure AFTER
        // record_stripe_event committed but BEFORE the paid transition leaves the event recorded
        // yet the order still checkout_pending. Because the event is now dedup-gated, the
        // transition would otherwise be skipped FOREVER — stranding a captured (money-in) order in
        // checkout_pending, shown as "Abandoned", never fulfilled, no confirmation email. Re-drive
        // the transition on Stripe's redelivery, but ONLY while the order is still checkout_pending;
        // an already-paid order (the ordinary duplicate) is a guarded no-op.
        await recoverStrandedPaidOrder(shopId, orderRef);
      }

      // Keep the OLTP money table consistent with order_fact: stamp financial_status='paid'. This
      // runs on EVERY succeeded delivery (not just the first), like emitPaidOrder, so it self-heals
      // — if a first-delivery stamp failed after the state committed to paid, the redelivery
      // re-applies it (a duplicate is idempotent). Scoped by state='paid' so a stale succeeded
      // redelivery for an order since moved to refunded is a guarded no-op, never re-asserting paid.
      const upd = await getSupabase()
        .from("orders")
        .update({ financial_status: "paid" })
        .eq("shop_id", shopId)
        .eq("id", orderRef)
        .eq("state", "paid");
      if (upd.error) throw upd.error;

      // WAREHOUSE EMIT — runs on ANY succeeded delivery (including duplicates). emitPaidOrder is
      // self-guarded (it emits only when the order is CURRENTLY paid) and idempotent (onConflict),
      // so this is the self-healing path: if the first-delivery emit threw AFTER the order
      // committed to paid, Stripe's at-least-once redelivery re-runs it and the order_fact /
      // order_line_fact / ad_click_ref rows land on the retry. A stale succeeded redelivery for an
      // order since moved to refunded is a guarded no-op. The event time is a stable source_version
      // across redeliveries of the same event.
      //
      // ponytail: the transition is still NOT in the same transaction as the event record, so a
      // crash AFTER record_stripe_event but BEFORE transitionOrder leaves a recorded event with an
      // un-transitioned order (the redelivery is duplicate-gated, so it won't re-transition — emit
      // then sees a non-paid order and no-ops). The GA upgrade folds the order CAS into the
      // record_stripe_event security-definer RPC; gating-on-first-delivery + self-healing emit is
      // the pilot guard.
      await emitPaidOrder(shopId, orderRef, new Date(event.created * 1000).toISOString());

      // COMMIT INVENTORY — turn the checkout's held reservations (keyed on the order id) into real
      // on_hand decrements. Runs on ANY succeeded delivery like emitPaidOrder: inventory_commit
      // only flips still-`held` rows to `committed`, so a redelivery finds nothing held and no-ops
      // (idempotent + self-healing). Untracked/digital orders simply have no held rows to commit.
      // This is the counterpart to createCheckout's reserveStock — reserve at checkout, commit on
      // payment — that makes the storefront path actually decrement stock instead of overselling.
      await commitReservation(shopId, orderRef);
    }
  }
  return { status: 200, processed, duplicate: !processed };
}

/**
 * Re-drive a stranded checkout_pending order to `paid` on a Stripe REDELIVERY. Only acts while the
 * order is still checkout_pending — the fingerprint of a first-delivery transient failure that
 * recorded the event but never transitioned the order. An order that already reached paid (the
 * ordinary duplicate delivery) or any other state is a no-op, so this never re-pays. The
 * confirmation email is sent exactly once: only on the redelivery that actually recovers the order.
 */
async function recoverStrandedPaidOrder(shopId: string, orderRef: string): Promise<void> {
  const cur = await getSupabase()
    .from("orders")
    .select("state")
    .eq("shop_id", shopId)
    .eq("id", orderRef)
    .maybeSingle();
  if (cur.error) throw cur.error;
  if (!cur.data || String((cur.data as Record<string, unknown>).state) !== "checkout_pending") return;
  await transitionOrder(shopId, orderRef, "paid", "stripe:payment_intent.succeeded:recovery");
  await sendOrderConfirmation(shopId, orderRef);
}
