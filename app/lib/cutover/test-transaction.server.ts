// Go-live payment probe (Step 9). The paid_order + captured_charge gates need a real
// cleared transaction; this originates the smallest one Stripe allows (50c USD) as a
// line-less owned order tagged channel='test', then hands it to the existing checkout
// session + webhook path — no new payment logic.
import { randomBytes } from "node:crypto";
import { getSupabase } from "~/lib/supabase.server";
import { getOrgMode } from "~/lib/cutover/org-mode.server";
import { getConnectedAccount } from "~/lib/payments/connect.server";
import { upsertGuestBuyer } from "~/lib/buyer/identity.server";
import { createCommerceCheckoutSession } from "~/lib/commerce/stripe-checkout.server";

/** Stripe's minimum chargeable amount (USD). ponytail: fixed 50c/usd; per-currency
 *  minimums if a non-USD test store ever needs it. */
export const TEST_CHARGE_CENTS = 50;

export async function startTestTransaction(shopId: string): Promise<{ url: string }> {
  if (!shopId) throw new Error("shopId is required");

  const mode = await getOrgMode(shopId);
  if (mode !== "dual_run") {
    throw new Error(`a test transaction can only be run in dual_run (shop is in ${mode})`);
  }
  if (!(await getConnectedAccount(shopId))) {
    throw new Error("Connect Stripe before running a test transaction.");
  }

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

  const session = await createCommerceCheckoutSession(shopId, {
    orderId: row.id,
    totalCents: TEST_CHARGE_CENTS,
    currency: "usd",
    confirmationToken: row.confirmation_token,
  });
  return { url: session.url };
}
