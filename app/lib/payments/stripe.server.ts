import type Stripe from "stripe";
import { getSupabase } from "~/lib/supabase.server";
import { transitionOrder } from "~/lib/order/order.server";
import { emitPaidOrder } from "~/lib/order/emit.server";
import { sendOrderConfirmation } from "~/lib/order/confirmation-email.server";
import { commitReservation, saleFallbackForOrder } from "~/lib/inventory/engine.server";
import { isLegalTransition, isOrderState, type OrderState } from "~/lib/order/state";
// Singleton lives in stripe-client.server so connect.server can use it without
// importing this module (which imports connect.server — would be a cycle).
import { getStripe } from "./stripe-client.server";
import { createRoutedPaymentIntent, applyAccountUpdate, type PaymentsReadiness } from "./connect.server";

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
  readiness?: PaymentsReadiness,
): Promise<{ paymentIntentId: string; clientSecret: string; amountCents: number; currency: string }> {
  if (!shopId) throw new Error("shopId is required");
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new Error(`amountCents must be a positive integer, got ${amountCents}`);
  }
  const cur = currency.toLowerCase();
  if (!KNOWN_CURRENCIES.has(cur)) {
    throw new Error(`unsupported currency: ${currency}`);
  }

  // Routing decision + fail-closed destination handling live in ONE seam
  // (createRoutedPaymentIntent) shared with the ACP charge path. `readiness` reuses
  // a decision the caller already gated on (createCheckout) — one read per charge.
  const { pi, stripeAccountId, applicationFeeCents } = await createRoutedPaymentIntent(
    shopId,
    {
      amount: amountCents,
      currency: cur,
      automatic_payment_methods: { enabled: true },
      metadata: { shop_id: shopId, order_ref: orderRef ?? "" },
    },
    { readiness },
  );
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

interface OwnedPaymentIntentRow {
  id: string;
  shop_id: string;
  order_ref: string | null;
  currency: string;
}

/**
 * Resolve the shop-scoped payment_intent row for a Stripe PaymentIntent id, used by both
 * charge.refunded and charge.dispute.created to decide whether a charge/dispute originated
 * through Calderyn before touching the ledger or the order. Returns null when no row matches
 * (a charge Calderyn never created — e.g. another integration on the same Stripe account).
 */
async function findOwnedPaymentIntent(piId: string): Promise<OwnedPaymentIntentRow | null> {
  const { data, error } = await getSupabase()
    .from("payment_intent")
    .select("id, shop_id, order_ref, currency")
    .eq("stripe_pi_id", piId)
    .maybeSingle();
  if (error) throw error;
  return (data as OwnedPaymentIntentRow | null) ?? null;
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
    // Hosted-session charges are destination-routed like every other charge site, and the
    // refund path decides reverse_transfer/refund_application_fee off this row's
    // stripe_account_id — so the reconciliation MUST stamp the routing columns, not leave
    // them null. The session event doesn't carry transfer_data; read it off the PI. A
    // retrieve failure throws (500) so Stripe redelivers and the stamp self-heals — a row
    // silently reconciled as "platform" for a routed charge would make its refund leak the
    // transferred funds to the merchant while the platform pays the buyer back.
    const sessionPi = await getStripe().paymentIntents.retrieve(piId);
    const destAcct =
      typeof sessionPi.transfer_data?.destination === "string"
        ? sessionPi.transfer_data.destination
        : (sessionPi.transfer_data?.destination?.id ?? null);
    const { error: upsertErr } = await getSupabase()
      .from("payment_intent")
      .upsert(
        {
          shop_id: sShopId,
          stripe_pi_id: piId,
          order_ref: session.metadata?.order_ref ?? null,
          amount_cents: session.amount_total ?? 0,
          currency: session.currency ?? "usd",
          stripe_account_id: destAcct,
          application_fee_cents: sessionPi.application_fee_amount ?? null,
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

  // Refunds issued from the STRIPE DASHBOARD (not ours) never touch executeRefundAction, so
  // without this branch they never reach transaction_ledger or the order state and the merchant's
  // Calderyn views lie. We reconcile off the charge's authoritative refund list rather than trust
  // the (possibly partial) `refunds` page embedded on the charge event payload. Every write goes
  // through record_refund_ledger — the SAME RPC executeRefundAction uses — so a refund WE issued
  // (already recorded under its Stripe refund id) replays as a no-op (`inserted:false`); only a
  // refund issued elsewhere inserts a new ledger row and reconciles the order.
  if (event.type === "charge.refunded") {
    const charge = event.data.object as Stripe.Charge;
    const piId =
      typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
    if (!piId) {
      console.warn(`[stripe] charge.refunded ${event.id}: charge ${charge.id} has no payment_intent; skipped`);
      return { status: 200, processed: false, duplicate: false };
    }

    const piRow = await findOwnedPaymentIntent(piId);
    if (!piRow) {
      console.warn(
        `[stripe] charge.refunded ${event.id}: no payment_intent row for PI ${piId}; charge not originated by Calderyn`,
      );
      return { status: 200, processed: false, duplicate: false };
    }
    const { id: paymentIntentId, shop_id: shopId, order_ref: orderRef } = piRow;
    const sb = getSupabase();

    const refunds = await getStripe().refunds.list({ charge: charge.id, limit: 100 });
    let insertedAny = false;
    let lastFullyRefunded = false;
    for (const refund of refunds.data) {
      if (refund.status !== "succeeded") continue;
      const { data: rpcData, error: rpcErr } = await sb.rpc("record_refund_ledger", {
        p_shop_id: shopId,
        p_payment_intent_id: paymentIntentId,
        p_order_ref: orderRef,
        p_amount_cents: refund.amount,
        p_currency: refund.currency,
        p_stripe_ref: charge.id,
        p_stripe_event_id: refund.id,
        p_occurred_at: new Date(refund.created * 1000).toISOString(),
      });
      if (rpcErr) throw rpcErr;
      const result = (rpcData ?? {}) as { fully_refunded?: boolean; inserted?: boolean };
      // fully_refunded reflects the CURRENT cumulative ledger total on every call (including a
      // replay), so tracking it unconditionally always ends the loop with the true final total —
      // no need to gate it on `inserted`.
      lastFullyRefunded = Boolean(result.fully_refunded);
      if (result.inserted) insertedAny = true;
    }

    // No refund on this charge was new to us — every succeeded refund was already recorded
    // (either by executeRefundAction or a prior delivery of this same event). Nothing to reconcile.
    if (!insertedAny) {
      return { status: 200, processed: false, duplicate: true };
    }

    if (!orderRef) {
      console.warn(
        `[stripe] charge.refunded ${event.id}: payment_intent ${paymentIntentId} has no order_ref; ledger recorded but order not reconciled`,
      );
      return { status: 200, processed: true, duplicate: false };
    }

    const resolvedState: OrderState = lastFullyRefunded ? "refunded" : "partially_refunded";
    const orderRead = await sb.from("orders").select("state").eq("shop_id", shopId).eq("id", orderRef).maybeSingle();
    if (orderRead.error) throw orderRead.error;
    const currentState = orderRead.data ? String((orderRead.data as Record<string, unknown>).state) : null;

    if (currentState && isOrderState(currentState) && resolvedState !== currentState) {
      if (isLegalTransition(currentState, resolvedState)) {
        await transitionOrder(shopId, orderRef, resolvedState, "stripe:charge.refunded");
      } else {
        // Never throw here — an illegal transition (e.g. the order is still checkout_pending) is a
        // state mismatch to reconcile manually, not a transient failure worth a Stripe retry storm.
        console.error(
          `[stripe] charge.refunded ${event.id}: order ${orderRef} (shop ${shopId}) state '${currentState}' cannot legally move to '${resolvedState}'; skipping transition — reconcile manually`,
        );
      }
    }

    // Mirrors executeRefundAction's tail: stamp financial_status on every reconciled delivery
    // (not just a state change), best-effort. Native refund_fact emission stays executor-only for
    // now (see emitNativeRefundFact in refund.server.ts) — this webhook path does not warehouse-emit.
    const finUpd = await sb
      .from("orders")
      .update({ financial_status: resolvedState })
      .eq("shop_id", shopId)
      .eq("id", orderRef);
    if (finUpd.error) {
      console.error(
        `[stripe] charge.refunded ${event.id}: financial_status stamp to '${resolvedState}' failed for order ${orderRef}`,
        finUpd.error,
      );
    }

    return { status: 200, processed: true, duplicate: false };
  }

  // Disputes are entirely invisible today — surface them loudly for an operator and flag the order
  // so the merchant's views stop lying, without moving money or order state in this iteration (no
  // ledger row, no state transition). financial_status is free text by design (see the order-spine
  // migration comment), so "disputed" is a safe label alongside `state`.
  if (event.type === "charge.dispute.created") {
    const dispute = event.data.object as Stripe.Dispute;
    const piId =
      typeof dispute.payment_intent === "string" ? dispute.payment_intent : dispute.payment_intent?.id;
    if (!piId) {
      console.warn(`[stripe] charge.dispute.created ${event.id}: dispute ${dispute.id} has no payment_intent; skipped`);
      return { status: 200, processed: false, duplicate: false };
    }

    const piRow = await findOwnedPaymentIntent(piId);
    if (!piRow) {
      console.warn(
        `[stripe] charge.dispute.created ${event.id}: no payment_intent row for PI ${piId}; dispute not ours`,
      );
      return { status: 200, processed: false, duplicate: false };
    }
    const { shop_id: shopId, order_ref: orderRef } = piRow;
    const sb = getSupabase();

    console.error(
      `[stripe] DISPUTE ${dispute.id} on order ${orderRef ?? "(no order_ref)"} (shop ${shopId}): ` +
        `${dispute.amount} ${dispute.currency} reason=${dispute.reason}; requires operator review`,
    );

    if (orderRef) {
      const finUpd = await sb
        .from("orders")
        .update({ financial_status: "disputed" })
        .eq("shop_id", shopId)
        .eq("id", orderRef)
        .in("state", ["paid", "fulfilled", "partially_refunded"]);
      if (finUpd.error) {
        console.error(
          `[stripe] charge.dispute.created ${event.id}: financial_status stamp to 'disputed' failed for order ${orderRef}`,
          finUpd.error,
        );
      }
    }

    return { status: 200, processed: true, duplicate: false };
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

      // PAID-WITHOUT-HOLD FALLBACK — inventory_commit only flips rows that were actually HELD; an
      // order that reaches `paid` with NOTHING ever reserved for it (a variant flipped to
      // inventory_tracked=true only after checkout, a reserveStock bug, a manually-created order)
      // makes commitReservation a silent no-op, so the sale never decrements on_hand — a silent
      // oversell hiding behind captured payment. Detect that case by reading whether a held or
      // committed inventory_reservation row exists for this checkout_ref; a released row (30-min
      // hold TTL expired, buyer paid later) means nothing was ever committed, so fall back to a
      // direct decrement. Runs on EVERY succeeded delivery like commitReservation itself: the
      // fallback RPC's per-(order,variant) idempotency key makes a redelivery a no-op. NEVER
      // thrown past — the payment already happened, so a failure here must never fail the webhook
      // (rule 12: log loudly instead).
      try {
        const heldRes = await getSupabase()
          .from("inventory_reservation")
          .select("id")
          .eq("shop_id", shopId)
          .eq("checkout_ref", orderRef)
          .in("state", ["held", "committed"])
          .limit(1);
        if (heldRes.error) throw heldRes.error;
        if (!heldRes.data || heldRes.data.length === 0) {
          await saleFallbackForOrder(shopId, orderRef);
        }
      } catch (fallbackErr) {
        console.error(
          `[stripe] paid-without-hold stock fallback failed for order ${orderRef} (shop ${shopId}) — ` +
            `payment already captured; on_hand may be overstated until reconciled manually:`,
          fallbackErr,
        );
      }
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
