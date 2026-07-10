// app/lib/buyer/account.server.ts
//
// Read models + account deletion for the buyer account surface (platform pivot #1b). Order
// history reuses the existing OLTP `orders` spine (which already carries buyer_id); saved
// addresses reuse `buyer_address`. All reads thread shop_id (service-role/BYPASSRLS path).

import { getSupabase } from "~/lib/supabase.server";
import type { BuyerAddress } from "./identity.server";
import { deleteBuyerStripeCustomer } from "./payment-methods.server";

export interface BuyerOrderSummary {
  orderId: string;
  state: string;
  financialStatus: string;
  totalCents: number;
  currency: string;
  createdAt: string;
  /** Unguessable per-order token that keys the buyer-facing confirmation/receipt page. */
  confirmationToken: string | null;
  /** Latest fulfillment tracking (shipped orders only); null when none was recorded. */
  trackingNumber: string | null;
  trackingCarrier: string | null;
}

function mapAddress(row: Record<string, unknown>): BuyerAddress {
  return {
    id: String(row.id),
    buyerId: String(row.buyer_id),
    kind: row.kind as BuyerAddress["kind"],
    name: row.name == null ? null : String(row.name),
    line1: row.line1 == null ? null : String(row.line1),
    line2: row.line2 == null ? null : String(row.line2),
    city: row.city == null ? null : String(row.city),
    region: row.region == null ? null : String(row.region),
    postal: row.postal == null ? null : String(row.postal),
    country: row.country == null ? null : String(row.country),
    phone: row.phone == null ? null : String(row.phone),
    isDefault: row.is_default === true,
  };
}

/** All saved addresses for a buyer, default-first within each kind. */
export async function listBuyerAddresses(shopId: string, buyerId: string): Promise<BuyerAddress[]> {
  if (!shopId) throw new Error("shopId is required");
  const { data, error } = await getSupabase()
    .from("buyer_address")
    .select("id, buyer_id, kind, name, line1, line2, city, region, postal, country, phone, is_default")
    .eq("shop_id", shopId)
    .eq("buyer_id", buyerId)
    .order("kind", { ascending: true })
    .order("is_default", { ascending: false });
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map(mapAddress);
}

/** The buyer's email, or null — used to prefill the checkout contact field for a signed-in buyer. */
export async function getBuyerEmail(shopId: string, buyerId: string): Promise<string | null> {
  if (!shopId) throw new Error("shopId is required");
  const { data, error } = await getSupabase()
    .from("buyer_dim")
    .select("email_normalized")
    .eq("shop_id", shopId)
    .eq("id", buyerId)
    .maybeSingle();
  if (error) throw error;
  return data?.email_normalized ? String(data.email_normalized) : null;
}

/** The buyer's default shipping address, or null — used to prefill checkout. */
export async function defaultShippingAddress(shopId: string, buyerId: string): Promise<BuyerAddress | null> {
  if (!shopId) throw new Error("shopId is required");
  const { data, error } = await getSupabase()
    .from("buyer_address")
    .select("id, buyer_id, kind, name, line1, line2, city, region, postal, country, phone, is_default")
    .eq("shop_id", shopId)
    .eq("buyer_id", buyerId)
    .eq("kind", "shipping")
    .eq("is_default", true)
    .maybeSingle();
  if (error) throw error;
  return data ? mapAddress(data as Record<string, unknown>) : null;
}

/** Delete one of the buyer's saved addresses (scoped so a buyer can only delete their own). */
export async function deleteBuyerAddress(shopId: string, buyerId: string, addressId: string): Promise<void> {
  if (!shopId) throw new Error("shopId is required");
  if (!addressId) return;
  const { error } = await getSupabase()
    .from("buyer_address")
    .delete()
    .eq("shop_id", shopId)
    .eq("buyer_id", buyerId)
    .eq("id", addressId);
  if (error) throw error;
}

// States that represent a real, money-captured order the buyer should see in their history. A
// checkout_pending row is born BEFORE payment (createCheckout) and nothing transitions an abandoned
// one to cancelled, so without this filter every abandoned checkout showed forever as a "Payment
// processing" order at full total, with no money captured. cart/checkout_pending/cancelled are
// excluded; a genuinely paid-then-cancelled path does not exist for owned orders.
const BUYER_HISTORY_STATES = ["paid", "fulfilled", "refunded", "partially_refunded"];

/** Order history: the buyer's OLTP orders at this shop, newest first. PII-free by construction. */
export async function listBuyerOrders(shopId: string, buyerId: string): Promise<BuyerOrderSummary[]> {
  if (!shopId) throw new Error("shopId is required");
  const { data, error } = await getSupabase()
    .from("orders")
    .select("id, state, financial_status, total_cents, currency, created_at, confirmation_token")
    .eq("shop_id", shopId)
    .eq("buyer_id", buyerId)
    .in("state", BUYER_HISTORY_STATES)
    .order("created_at", { ascending: false });
  if (error) throw error;
  const rows = (data ?? []) as Record<string, unknown>[];

  // Latest recorded tracking per order, one batched read (newest fulfillment with a
  // tracking number wins). Best-effort: a fulfillment read failure renders history
  // without tracking rather than failing the whole account page.
  const tracking = new Map<string, { number: string; carrier: string | null }>();
  if (rows.length > 0) {
    const ful = await getSupabase()
      .from("order_fulfillment")
      .select("order_id, tracking_number, carrier, created_at")
      .eq("shop_id", shopId)
      .in("order_id", rows.map((o) => String(o.id)))
      .not("tracking_number", "is", null)
      .order("created_at", { ascending: false });
    if (ful.error) {
      console.error(`[account] order_fulfillment read failed for shop ${shopId}:`, ful.error.message);
    } else {
      for (const f of (ful.data ?? []) as Record<string, unknown>[]) {
        const orderId = String(f.order_id);
        if (!tracking.has(orderId) && f.tracking_number) {
          tracking.set(orderId, {
            number: String(f.tracking_number),
            carrier: f.carrier == null ? null : String(f.carrier),
          });
        }
      }
    }
  }

  return rows.map((o) => {
    const t = tracking.get(String(o.id)) ?? null;
    return {
      orderId: String(o.id),
      state: String(o.state),
      financialStatus: String(o.financial_status),
      totalCents: Number(o.total_cents),
      currency: String(o.currency),
      createdAt: String(o.created_at),
      confirmationToken: o.confirmation_token == null ? null : String(o.confirmation_token),
      trackingNumber: t?.number ?? null,
      trackingCarrier: t?.carrier ?? null,
    };
  });
}

/**
 * GDPR account deletion. Respects the PII/warehouse split: it deletes the buyer's PII from the
 * buyer_* store and detaches their vaulted cards from Stripe, but NEVER touches the analytics
 * warehouse (order_fact / order_line_fact) — those hold no buyer PII and are a separate spine.
 *
 * Order of operations:
 *  1. Delete the buyer's Stripe Customer (removes all vaulted PaymentMethods) — done FIRST, while
 *     the stripe_customer_id is still readable from buyer_dim. Best-effort (logged, not thrown).
 *  2. Delete the buyer_dim row. Its ON DELETE CASCADE composite FKs remove the buyer's PII —
 *     buyer_address, buyer_consent, buyer_magic_link, buyer_session (so every live session is gone —
 *     stronger than a revoke), and buyer_payment_method. The OLTP `orders` FK is column-scoped
 *     SET NULL (20260707120000): a delete NULLs only orders.buyer_id, DETACHING the buyer from their
 *     captured sales while preserving the orders + order_line rows the merchant's revenue surfaces
 *     read. So the account's PII is erased but past sales are never dropped from Analytics / Orders.
 */
export async function deleteBuyerAccount(shopId: string, buyerId: string): Promise<void> {
  if (!shopId) throw new Error("shopId is required");
  if (!buyerId) throw new Error("buyerId is required");

  await deleteBuyerStripeCustomer(shopId, buyerId);

  const { error } = await getSupabase()
    .from("buyer_dim")
    .delete()
    .eq("shop_id", shopId)
    .eq("id", buyerId);
  if (error) throw error;
}
