// Go-live payment probe (Step 9). The paid_order + captured_charge gates need a real
// cleared transaction; this originates the smallest one Stripe allows (50c USD) as a
// line-less owned order tagged channel='test', then hands it to the existing checkout
// session + webhook path — no new payment logic.
import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "~/lib/supabase.server";
import { getOrgMode } from "~/lib/cutover/org-mode.server";
import { paymentsReadiness, type PaymentsReadiness } from "~/lib/payments/connect.server";
import { upsertGuestBuyer } from "~/lib/buyer/identity.server";
import { createCommerceCheckoutSession } from "~/lib/commerce/stripe-checkout.server";
import { executeRefundAction } from "~/lib/actions/refund.server";
import { CalderynError } from "~/lib/calderyn.server";
import { GOLIVE_PATH, TEST_TX_PARAM, TEST_TX_SUCCESS, TEST_TX_CANCELLED } from "./test-tx-return";

/** Stripe's minimum chargeable amount (USD). ponytail: fixed 50c/usd; per-currency
 *  minimums if a non-USD test store ever needs it. */
export const TEST_CHARGE_CENTS = 50;

/**
 * `returnOrigin` is the merchant's validated browser origin (requireSameOrigin's
 * return value). The probe is a MERCHANT flow: Stripe must send them back to the
 * Go live screen on the host their session cookie lives on — not the buyer
 * storefront, where the platform host resolves to the demo shell and the
 * confirmation dead-ends. Required so no caller can fall back to a host the
 * merchant may not be signed in on. (Sibling resolver for the other Stripe-hosted
 * merchant flow: onboardingOrigin in ~/lib/payments/connect.server — env-first;
 * consolidate if these ever need to agree.)
 */
export async function startTestTransaction(
  shopId: string,
  returnOrigin: string,
): Promise<{ url: string }> {
  if (!shopId) throw new Error("shopId is required");
  if (!returnOrigin) throw new Error("returnOrigin is required");

  const mode = await getOrgMode(shopId);
  if (mode !== "dual_run") {
    throw new Error(`a test transaction can only be run in dual_run (shop is in ${mode})`);
  }
  // Full readiness, not mere account existence: the probe exercises the REAL charge
  // path, which fails closed for a half-onboarded account — gate here (BEFORE the
  // probe order is written) with the merchant-actionable message instead of letting
  // the session create throw deeper and orphan a channel='test' order. The decision
  // is reused by the session create below (one readiness read per probe).
  const readiness = await paymentsReadiness(shopId);
  if (!readiness.ready) {
    throw new Error("Finish connecting Stripe (charges and payouts enabled) before running a test transaction.");
  }

  const golive = `${returnOrigin}${GOLIVE_PATH}`;
  return createTestProbeCheckout(shopId, readiness, {
    // The Cutover screen reads the return marker to confirm the payment (success) or
    // note the abandoned checkout (cancelled) without the merchant hunting for Re-check.
    success: `${golive}?${TEST_TX_PARAM}=${TEST_TX_SUCCESS}`,
    cancel: `${golive}?${TEST_TX_PARAM}=${TEST_TX_CANCELLED}`,
  });
}

/**
 * Journey "place a test order": same 50c probe as the go-live gate (guest-buyer upsert
 * -> channel='test' order -> Stripe Checkout session), but for the onboarding journey's
 * own milestone — no org-mode requirement, since native (never-dual_run) shops must be
 * able to run it too. The probe is refunded by the journey API on confirm, not by
 * transitionOrgMode, so it never touches org_mode.
 */
export async function startJourneyTestOrder(shopId: string, returnOrigin: string): Promise<{ url: string }> {
  if (!shopId) throw new Error("shopId is required");
  if (!returnOrigin) throw new Error("returnOrigin is required");

  const readiness = await paymentsReadiness(shopId);
  if (!readiness.ready) {
    // CalderynError (not a bare Error) so dashboardJson surfaces this exact message to
    // the merchant instead of collapsing it into a generic 500 "internal_error".
    throw new CalderynError({
      status: 400,
      code: "stripe_not_ready",
      message: "Connect Stripe (charges and payouts enabled) before running a test order.",
    });
  }

  const home = `${returnOrigin}/dashboard`;
  return createTestProbeCheckout(shopId, readiness, {
    success: `${home}?test_order=success`,
    cancel: `${home}?test_order=cancelled`,
  });
}

/**
 * Shared probe core: originate a channel='test' order at the Stripe minimum and hand it
 * to the existing checkout session + webhook path. `returnUrls` differ per caller (the
 * Go live screen vs. the Home journey card); everything else — buyer upsert, order
 * shape, checkout params — is identical.
 */
async function createTestProbeCheckout(
  shopId: string,
  readiness: PaymentsReadiness,
  returnUrls: { success: string; cancel: string },
): Promise<{ url: string }> {
  // orders.buyer_id is NOT NULL (order_spine.sql:122) — every money-path order carries a
  // buyer, so the probe reuses the same guest-buyer upsert the storefront checkout uses.
  const buyer = await upsertGuestBuyer(shopId, { email: "test-probe@calderyn.internal" });
  const confirmationToken = randomBytes(32).toString("base64url");
  const { data, error } = await getSupabase()
    .from("orders")
    .insert({
      shop_id: shopId,
      buyer_id: buyer.id,
      channel: "test",
      subtotal_cents: TEST_CHARGE_CENTS,
      shipping_cents: 0,
      tax_cents: 0,
      total_cents: TEST_CHARGE_CENTS,
      currency: "usd",
      confirmation_token: confirmationToken,
      // state defaults to 'checkout_pending'; no lines, no inventory reserved.
    })
    .select("id, confirmation_token")
    .single();
  if (error) throw error;
  const row = data as { id: string; confirmation_token: string };

  const session = await createCommerceCheckoutSession(
    shopId,
    {
      orderId: row.id,
      totalCents: TEST_CHARGE_CENTS,
      currency: "usd",
      confirmationToken: row.confirmation_token,
      returnUrls,
    },
    readiness,
  );
  return { url: session.url };
}

/**
 * Post-cutover cleanup: full-refund every paid channel='test' probe order for the shop.
 * Called by transitionOrgMode AFTER the -> live commit, so the probe was still `paid`
 * when the gate ran. Fail-loud but non-blocking (rule 12): the cutover already committed,
 * so a refund failure is logged + swallowed, never thrown back onto the live move. The
 * `capture` ledger row persists regardless, so captured_charge stays satisfied.
 */
export async function refundTestOrders(shopId: string, sb: SupabaseClient): Promise<void> {
  const { data, error } = await sb
    .from("orders")
    .select("id")
    .eq("shop_id", shopId)
    .eq("channel", "test");
  if (error) {
    console.error(`[cutover] failed to list test orders for shop ${shopId}`, error);
    return;
  }
  for (const row of (data ?? []) as Array<{ id: string }>) {
    try {
      await executeRefundAction(
        shopId,
        { orderId: row.id, idempotencyKey: `test-refund:${row.id}`, triggerReason: "go_live_test_cleanup" },
        sb,
      );
    } catch (err) {
      console.error(`[cutover] failed to refund test order ${row.id} for shop ${shopId}`, err);
    }
  }
}
