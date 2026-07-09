// Abandoned-checkout order reaper (platform cron). Orders are BORN `checkout_pending`
// (checkout.server.ts createCheckout) and the inventory reaper (inventory/reaper.server.ts,
// every 5 min) only releases their 30-min stock holds — nothing ever moves the ORDER itself.
// If the buyer never pays, the order sits `checkout_pending` forever and its Stripe
// PaymentIntent client_secret stays confirmable indefinitely: a buyer could return days later
// and pay a stale quote (prices, stock, shipping all possibly drifted). This sweep closes that
// gap by cancelling the PI (so the stale client_secret can never be confirmed) and transitioning
// the order to `cancelled` — the legal checkout_pending -> cancelled edge in state.ts that
// nothing else drives.
//
// 24h is deliberate, not arbitrary: the dashboard's Abandoned tab (list.server.ts,
// ABANDON_AFTER_MS) starts labeling a stalled checkout at 1h so merchants get a 23h recovery
// window (follow-up email, etc.) before we act. Past 24h the quote is stale enough that letting
// the old PaymentIntent capture would charge on faith in day-old prices/stock/shipping — wrong
// to allow regardless of recovery odds.
//
// channel='test' go-live probe orders (see list.server.ts) are checkout_pending like any other
// order and age out through this same sweep — no special-casing needed.
import { getSupabase } from "~/lib/supabase.server";
import { getStripe } from "~/lib/payments/stripe-client.server";
import { releaseReservation } from "~/lib/inventory/engine.server";
import { transitionOrder } from "./order.server";

const REAP_AFTER_MS = 24 * 60 * 60 * 1000;
const BATCH_LIMIT = 200;
const TERMINAL_PI_STATUSES = new Set(["succeeded", "canceled"]);

export interface AbandonReaperResult {
  scanned: number;
  cancelled: number;
  skippedPaidRace: number;
  failed: number;
}

interface StaleOrderRow {
  id: string;
  shop_id: string;
}

interface PaymentIntentRow {
  stripe_pi_id: string;
  status: string;
}

/**
 * Best-effort local read-model stamp after a Stripe-side void. Without it our payment_intent row
 * keeps its pre-cancel status forever — the Stripe webhook only listens for succeeded /
 * payment_failed, never .canceled — and listPendingIntents (payments/summary.server.ts), which
 * filters status NOT IN (succeeded, canceled), would show every reaper-voided PI as "pending" on
 * the dashboard Payments screen indefinitely. A failed stamp is logged LOUDLY but never
 * propagated: Stripe already holds the truth (the PI is void), so the order cancellation must
 * proceed regardless.
 */
async function stampPiCanceled(shopId: string, stripePiId: string): Promise<void> {
  try {
    const upd = await getSupabase()
      .from("payment_intent")
      .update({ status: "canceled", updated_at: new Date().toISOString() })
      .eq("stripe_pi_id", stripePiId)
      .eq("shop_id", shopId);
    if (upd.error) throw upd.error;
  } catch (err) {
    console.error(
      `[abandon-reaper] failed to stamp payment_intent ${stripePiId} (shop ${shopId}) canceled ` +
        `locally — Stripe-side void stands; the row lingers in the Payments pending list until re-stamped:`,
      err,
    );
  }
}

/**
 * Cancel abandoned checkouts: `orders` rows still `checkout_pending` more than 24h after
 * creation, across every shop (this is a platform cron, not shop-scoped). For each: void any
 * non-terminal Stripe PaymentIntent, release any inventory holds the 30-min reaper missed, then
 * transition the order to `cancelled`. The PI is ALWAYS voided before the order is transitioned
 * (step order matters) so a stale client_secret can never be confirmed after the order is
 * cancelled.
 *
 * A "paid race" — a PI that actually succeeded while the paid webhook is late or stuck — is
 * detected and the order is left alone (skippedPaidRace, loudly logged): the webhook's
 * redelivery self-heal (stripe.server.ts recoverStrandedPaidOrder) is what should drive that
 * order to `paid`, and cancelling it here would silently strand a captured payment.
 *
 * Each order is isolated in its own try/catch so one failure (a transient RPC error, a Stripe
 * outage) never aborts the sweep for the rest of the batch (rule 12: fail visibly, keep going).
 */
export async function reapAbandonedCheckouts(): Promise<AbandonReaperResult> {
  const sb = getSupabase();
  const cutoff = new Date(Date.now() - REAP_AFTER_MS).toISOString();

  const staleRes = await sb
    .from("orders")
    .select("id, shop_id")
    .eq("state", "checkout_pending")
    .lt("created_at", cutoff)
    .order("created_at", { ascending: true })
    .limit(BATCH_LIMIT);
  if (staleRes.error) throw staleRes.error;
  const stale = (staleRes.data ?? []) as StaleOrderRow[];

  let cancelled = 0;
  let skippedPaidRace = 0;
  let failed = 0;

  for (const order of stale) {
    const orderId = String(order.id);
    const shopId = String(order.shop_id);
    try {
      const piRes = await sb
        .from("payment_intent")
        .select("stripe_pi_id, status")
        .eq("order_ref", orderId)
        .eq("shop_id", shopId);
      if (piRes.error) throw piRes.error;
      const pis = (piRes.data ?? []) as PaymentIntentRow[];

      // The buyer actually paid and the paid webhook is late or stuck — never cancel a captured
      // order out from under a payment. This is a webhook-health signal, not a normal outcome:
      // log LOUDLY so it gets noticed. record_stripe_event's redelivery self-heal is what should
      // move this order to `paid`.
      if (pis.some((p) => p.status === "succeeded")) {
        skippedPaidRace++;
        console.error(
          `[abandon-reaper] ORDER ${orderId} (shop ${shopId}) HAS A SUCCEEDED PaymentIntent but is ` +
            `still checkout_pending — the paid webhook appears stuck. Skipping cancellation; investigate.`,
        );
        continue;
      }

      // Void every non-terminal PI at Stripe BEFORE touching the order, so the stale client_secret
      // can never be confirmed once the order is cancelled below. INVARIANT: the order may only
      // transition to cancelled once every non-terminal PI is VERIFIABLY un-confirmable (the
      // Stripe cancel succeeded, or a retrieve shows canceled).
      let paidRace = false;
      let unverifiedVoid = false;
      for (const pi of pis) {
        if (TERMINAL_PI_STATUSES.has(pi.status)) continue;
        try {
          await getStripe().paymentIntents.cancel(pi.stripe_pi_id);
        } catch (cancelErr) {
          // The cancel can fail because Stripe already captured it (a late-arriving succeeded PI —
          // same paid-race as above, just discovered here instead of via our stale local status
          // row) or because it's already canceled. Retrieve-and-check is the simplest robust way
          // to tell the two apart without parsing Stripe's error codes/messages.
          const retrieved = await getStripe().paymentIntents.retrieve(pi.stripe_pi_id);
          if (retrieved.status === "succeeded") {
            paidRace = true;
            console.error(
              `[abandon-reaper] PaymentIntent ${pi.stripe_pi_id} for order ${orderId} (shop ${shopId}) ` +
                `succeeded at Stripe during cancel — paid webhook appears stuck. Skipping order; investigate.`,
              cancelErr,
            );
            break;
          }
          if (retrieved.status === "canceled") {
            // Already canceled at Stripe (verifiably un-confirmable): sync our stale local row too.
            await stampPiCanceled(shopId, pi.stripe_pi_id);
            continue;
          }
          // Cancel failed and the PI is STILL LIVE (e.g. a transient Stripe error): the order
          // must NOT be cancelled this sweep. A cancelled order with a live client_secret can
          // still capture buyer money, and the webhook's paid transition would then be REJECTED
          // by the state machine (cancelled is terminal) — stranding real captured funds on a
          // cancelled order, far worse than a stale checkout_pending row for one more hour. Skip
          // the whole order (counted failed); the next hourly run retries the void.
          unverifiedVoid = true;
          console.error(
            `[abandon-reaper] could not void PaymentIntent ${pi.stripe_pi_id} for order ${orderId} ` +
              `(shop ${shopId}) — still '${retrieved.status}' at Stripe after a failed cancel. ` +
              `Leaving the order checkout_pending; the next run retries:`,
            cancelErr,
          );
          break;
        }
        // Stripe-side void succeeded — keep the local read model in step. NEVER stamped on the
        // paid race above: the succeeded webhook (record_stripe_event) owns that row's status.
        await stampPiCanceled(shopId, pi.stripe_pi_id);
      }
      if (paidRace) {
        skippedPaidRace++;
        continue;
      }
      if (unverifiedVoid) {
        failed++;
        continue;
      }

      // Belt-and-braces: the 30-min inventory reaper normally already released these holds;
      // release is idempotent on an already-released checkout_ref.
      await releaseReservation(shopId, orderId);

      try {
        await transitionOrder(shopId, orderId, "cancelled", "cron:abandoned_checkout");
      } catch (transitionErr) {
        // CAS-guarded: if the paid webhook raced us and won between our reads above and this
        // write, transitionOrder throws (order changed under us / illegal transition). That's the
        // paid race again, just discovered at the last possible moment — never a hard failure.
        skippedPaidRace++;
        console.error(
          `[abandon-reaper] order ${orderId} (shop ${shopId}) cancel-transition rejected — likely won ` +
            `by the paid webhook mid-sweep. Skipping; investigate if this recurs:`,
          transitionErr,
        );
        continue;
      }

      cancelled++;
    } catch (err) {
      failed++;
      console.error(
        `[abandon-reaper] failed to process abandoned order ${orderId} (shop ${shopId}); continuing:`,
        err,
      );
    }
  }

  return { scanned: stale.length, cancelled, skippedPaidRace, failed };
}
