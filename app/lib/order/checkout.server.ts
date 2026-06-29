// Checkout origination (platform pivot #2b). Server-only: turns a priced cart into a
// Calderyn-native `orders` row in `checkout_pending` plus a Stripe PaymentIntent, threading
// shop_id explicitly on every write exactly like cart.server.ts / order.server.ts (the app
// reaches Postgres only through the service-role client; the migration's current_shop_id()
// RLS guards the PostgREST path). Money is integer cents throughout.
//
// The order's lines are SNAPSHOTTED from the cart into `order_line` here so the warehouse
// emission (#2b, emit.server.ts) and fulfillment can read them back without re-pricing — the
// `orders` row carries no cart_id, so the snapshot is the only link to what was bought.
//
// TODO(parity): native-originated `orders` / `order_line` rows have no merchant-facing surface
// in the Calderyn dashboard yet — the dashboard order view still only shows Shopify-origin
// order_fact. Mirror native orders into that view when the dashboard order surface is built
// (CLAUDE.md "Dashboard parity"); the warehouse emit already feeds the analytics views for free.

import { getSupabase } from "~/lib/supabase.server";
import { priceCart } from "./cart.server";
import {
  upsertGuestBuyer,
  addBuyerAddress,
  recordCheckoutConsent,
  type BuyerAddressInput,
} from "~/lib/buyer/identity.server";
import { createPaymentIntent } from "~/lib/payments/stripe.server";

// FLAT placeholders for the pilot — real shipping + tax calculation is a later step. The
// orders / checkout_session columns default to 0 with the same note (20260629110000_order_spine).
const PILOT_FLAT_SHIPPING_CENTS = 0;
const PILOT_FLAT_TAX_CENTS = 0;

export interface CheckoutBuyer {
  email: string;
  phone?: string | null;
  /** Optional shipping address captured at checkout (#1 buyer identity). */
  address?: BuyerAddressInput;
  /** Optional consent capture (ToS + privacy required, marketing opt-in). */
  consent?: {
    version: string;
    marketingOptIn: boolean;
    sourceIp?: string | null;
    ua?: string | null;
  };
}

export interface CheckoutResult {
  orderId: string;
  clientSecret: string;
}

/**
 * Originate a checkout: price the cart, identify the buyer, persist a `checkout_pending`
 * `orders` row (+ snapshotted `order_line`s), and create the Stripe PaymentIntent keyed to
 * that order. `attribution` is a pass-through snapshot of whatever the caller captured (an
 * empty object is fine); it is persisted verbatim on the order and replayed to the warehouse
 * as ad_click_ref breadcrumbs on payment (emit.server.ts). Returns the order id + client
 * secret for the buyer-side Payment Element (#2c builds that UI).
 *
 * ponytail: the buyer upsert + order insert + line insert + PI create are separate non-tx
 * PostgREST/Stripe calls (mirrors the non-atomic multi-write in identity.server.ts). A crash
 * mid-sequence leaves a checkout_pending order with no PI (never a paid order — the order only
 * reaches `paid` when Stripe confirms capture, see stripe.server.ts), which the buyer simply
 * re-originates. Folding the order writes into one security-definer RPC is the GA upgrade.
 */
export async function createCheckout(
  shopId: string,
  cartId: string,
  buyer: CheckoutBuyer,
  attribution: Record<string, unknown> = {},
): Promise<CheckoutResult> {
  if (!shopId) throw new Error("shopId is required");
  if (!cartId) throw new Error("cartId is required");
  if (!buyer?.email) throw new Error("buyer.email is required to originate a checkout");

  const priced = await priceCart(shopId, cartId);
  const shippingCents = PILOT_FLAT_SHIPPING_CENTS;
  const taxCents = PILOT_FLAT_TAX_CENTS;
  const totalCents = priced.subtotalCents + shippingCents + taxCents;

  // Fail visibly (rule 12) BEFORE any buyer/order write. Guard the computed TOTAL, not just an
  // empty cart: a non-empty cart that totals 0 cents (e.g. all-free items — unit_price_cents=0
  // is allowed) would otherwise pass an emptiness check, write the buyer + order + lines, then
  // have createPaymentIntent reject the non-positive amount — leaving an orphan checkout_pending
  // order with no PaymentIntent. Rejecting on the total covers both the empty and $0 cases.
  if (totalCents <= 0) {
    throw new Error(`cannot originate a checkout for cart ${cartId}: nothing to charge (total ${totalCents} cents)`);
  }

  const buyerRow = await upsertGuestBuyer(shopId, { email: buyer.email, phone: buyer.phone });
  if (buyer.address) {
    await addBuyerAddress(shopId, buyerRow.id, buyer.address);
  }
  if (buyer.consent) {
    await recordCheckoutConsent(shopId, buyerRow.id, buyer.consent);
  }

  const sb = getSupabase();
  const orderIns = await sb
    .from("orders")
    .insert({
      shop_id: shopId,
      buyer_id: buyerRow.id,
      // state defaults to 'checkout_pending' (orders.state default); the order is BORN here.
      subtotal_cents: priced.subtotalCents,
      shipping_cents: shippingCents,
      tax_cents: taxCents,
      total_cents: totalCents,
      currency: priced.currency,
      attribution, // pass-through snapshot; replayed as ad_click_ref on payment
    })
    .select("id")
    .single();
  if (orderIns.error) throw orderIns.error;
  if (!orderIns.data) throw new Error("orders insert returned no row");
  const orderId = String((orderIns.data as Record<string, unknown>).id);

  // Snapshot the cart lines onto the order (variant_id + price + title carried verbatim from
  // the cart_line snapshot — what the buyer saw is what is recorded on the order).
  const lineRows = priced.lines.map((l) => ({
    shop_id: shopId,
    order_id: orderId,
    variant_id: l.variantId,
    quantity: l.quantity,
    unit_price_cents: l.unitPriceCents,
    title_snapshot: l.titleSnapshot,
  }));
  const lineIns = await sb.from("order_line").insert(lineRows);
  if (lineIns.error) throw lineIns.error;

  const pi = await createPaymentIntent(shopId, totalCents, priced.currency, orderId);

  return { orderId, clientSecret: pi.clientSecret };
}
