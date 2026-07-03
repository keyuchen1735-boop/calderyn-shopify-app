// app/lib/buyer/payment-methods.server.ts
//
// Saved cards for buyer accounts (platform pivot #1b). Cards are VAULTED IN STRIPE via a
// per-buyer Stripe Customer + a SetupIntent (the buyer enters card details into Stripe's
// Payment Element; the raw card never touches our server). We persist ONLY Stripe's display
// fields (brand / last4 / exp) + the Stripe ids in buyer_payment_method — never a PAN or CVV,
// so PCI scope is not expanded.
//
// The Stripe Customer lives on the PLATFORM account (same account the checkout PaymentIntent is
// created on — Connect routing uses destination charges, so the PI + Customer + PaymentMethod
// all live on the platform account and a saved card is reusable at checkout).

import { getStripe } from "~/lib/payments/stripe.server";
import { getSupabase } from "~/lib/supabase.server";

export interface SavedCard {
  id: string;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
  stripePaymentMethodId: string;
}

function mapCard(row: Record<string, unknown>): SavedCard {
  return {
    id: String(row.id),
    brand: row.brand == null ? null : String(row.brand),
    last4: row.last4 == null ? null : String(row.last4),
    expMonth: row.exp_month == null ? null : Number(row.exp_month),
    expYear: row.exp_year == null ? null : Number(row.exp_year),
    stripePaymentMethodId: String(row.stripe_payment_method_id),
  };
}

/**
 * Resolve the buyer's Stripe Customer id, creating it on first use. Stored on buyer_dim so it
 * survives with zero saved cards. shop_id leads on every read (service-role/BYPASSRLS path).
 */
export async function ensureBuyerStripeCustomer(shopId: string, buyerId: string): Promise<string> {
  if (!shopId) throw new Error("shopId is required");
  if (!buyerId) throw new Error("buyerId is required");
  const sb = getSupabase();
  const { data, error } = await sb
    .from("buyer_dim")
    .select("id, email_normalized, stripe_customer_id")
    .eq("shop_id", shopId)
    .eq("id", buyerId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`buyer ${buyerId} not found in shop ${shopId}`);
  const existing = data.stripe_customer_id;
  if (existing) return String(existing);

  const customer = await getStripe().customers.create({
    email: data.email_normalized ? String(data.email_normalized) : undefined,
    metadata: { shop_id: shopId, buyer_id: buyerId },
  });
  const upd = await sb
    .from("buyer_dim")
    .update({ stripe_customer_id: customer.id })
    .eq("shop_id", shopId)
    .eq("id", buyerId);
  if (upd.error) throw upd.error;
  return customer.id;
}

/**
 * Start the add-a-card flow: create a SetupIntent bound to the buyer's Customer and return its
 * client secret for the Payment Element. usage:'off_session' so the saved card can later be
 * charged at checkout without the buyer present.
 */
export async function createBuyerSetupIntent(
  shopId: string,
  buyerId: string,
): Promise<{ clientSecret: string; customerId: string }> {
  const customerId = await ensureBuyerStripeCustomer(shopId, buyerId);
  const si = await getStripe().setupIntents.create({
    customer: customerId,
    usage: "off_session",
    automatic_payment_methods: { enabled: true },
    metadata: { shop_id: shopId, buyer_id: buyerId },
  });
  if (!si.client_secret) throw new Error(`SetupIntent ${si.id} returned no client_secret`);
  return { clientSecret: si.client_secret, customerId };
}

/**
 * After the browser confirms a SetupIntent, persist the resulting card. Retrieves the SetupIntent
 * from Stripe (the source of truth — the browser only hands back an id), verifies it succeeded and
 * belongs to THIS buyer's Customer (so a forged id can't attach another buyer's card), then upserts
 * the display fields. Idempotent on (shop_id, stripe_payment_method_id): a refresh of the return
 * page re-saves the same card without duplicating. Returns the saved card, or null if not saveable.
 */
export async function saveConfirmedCard(
  shopId: string,
  buyerId: string,
  setupIntentId: string,
): Promise<SavedCard | null> {
  if (!shopId) throw new Error("shopId is required");
  if (!buyerId) throw new Error("buyerId is required");
  if (!setupIntentId) return null;

  const customerId = await ensureBuyerStripeCustomer(shopId, buyerId);
  const si = await getStripe().setupIntents.retrieve(setupIntentId, { expand: ["payment_method"] });
  if (si.status !== "succeeded") return null;
  // Ownership guard: the SetupIntent must belong to this buyer's Customer.
  const siCustomer = typeof si.customer === "string" ? si.customer : si.customer?.id;
  if (siCustomer !== customerId) return null;

  const pm = si.payment_method;
  if (!pm || typeof pm === "string") return null; // expected the expanded object
  const card = pm.card;

  const { data, error } = await getSupabase()
    .from("buyer_payment_method")
    .upsert(
      {
        shop_id: shopId,
        buyer_id: buyerId,
        stripe_customer_id: customerId,
        stripe_payment_method_id: pm.id,
        brand: card?.brand ?? null,
        last4: card?.last4 ?? null,
        exp_month: card?.exp_month ?? null,
        exp_year: card?.exp_year ?? null,
        detached_at: null,
      },
      { onConflict: "shop_id,stripe_payment_method_id" },
    )
    .select("id, brand, last4, exp_month, exp_year, stripe_payment_method_id")
    .single();
  if (error) throw error;
  return mapCard(data as Record<string, unknown>);
}

/** List a buyer's active (not detached) saved cards, newest first. */
export async function listSavedCards(shopId: string, buyerId: string): Promise<SavedCard[]> {
  if (!shopId) throw new Error("shopId is required");
  const { data, error } = await getSupabase()
    .from("buyer_payment_method")
    .select("id, brand, last4, exp_month, exp_year, stripe_payment_method_id")
    .eq("shop_id", shopId)
    .eq("buyer_id", buyerId)
    .is("detached_at", null)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map(mapCard);
}

/**
 * Remove a saved card: detach it in Stripe (so it can no longer be charged) and soft-delete the
 * row. Scoped to (shop, buyer) so a buyer can only detach their OWN card. No-op-safe: an unknown
 * or already-detached row returns false.
 */
export async function detachCard(shopId: string, buyerId: string, cardRowId: string): Promise<boolean> {
  if (!shopId) throw new Error("shopId is required");
  if (!buyerId) throw new Error("buyerId is required");
  if (!cardRowId) return false;
  const sb = getSupabase();
  const { data, error } = await sb
    .from("buyer_payment_method")
    .select("id, stripe_payment_method_id")
    .eq("shop_id", shopId)
    .eq("buyer_id", buyerId)
    .eq("id", cardRowId)
    .is("detached_at", null)
    .maybeSingle();
  if (error) throw error;
  if (!data) return false;

  // Detach in Stripe first — the vaulted card is the thing that must stop being chargeable. If
  // Stripe rejects (e.g. already detached), surface it rather than silently marking the row gone.
  await getStripe().paymentMethods.detach(String(data.stripe_payment_method_id));
  const upd = await sb
    .from("buyer_payment_method")
    .update({ detached_at: new Date().toISOString() })
    .eq("shop_id", shopId)
    .eq("id", String(data.id));
  if (upd.error) throw upd.error;
  return true;
}

/**
 * Delete the buyer's Stripe Customer (which removes all its vaulted PaymentMethods) as part of
 * account deletion. Best-effort: a Stripe failure is logged, not thrown, so a transient Stripe
 * outage can't block the buyer's DB-side deletion (rule 12 — the failure is surfaced, not hidden).
 */
export async function deleteBuyerStripeCustomer(shopId: string, buyerId: string): Promise<void> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("buyer_dim")
    .select("stripe_customer_id")
    .eq("shop_id", shopId)
    .eq("id", buyerId)
    .maybeSingle();
  if (error) throw error;
  const customerId = data?.stripe_customer_id ? String(data.stripe_customer_id) : null;
  if (!customerId) return;
  try {
    await getStripe().customers.del(customerId);
  } catch (err) {
    console.error(
      `[buyer-account] failed to delete Stripe customer ${customerId} for buyer ${buyerId} (shop ${shopId}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
